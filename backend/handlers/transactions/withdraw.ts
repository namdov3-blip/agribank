import { VercelRequest, VercelResponse } from '@vercel/node';
import connectDB from '../../../lib/mongodb';
import { Transaction, Project, BankTransaction, AuditLog, Settings } from '../../../lib/models';
import { authMiddleware } from '../../../lib/auth';
import { toZonedTime, format as formatTz } from 'date-fns-tz';
import { calculateInterest, calculateInterestWithRateChange, getVNStartOfDay } from '../../../lib/utils/interest';
import { fromVNTime } from '../../../utils/helpers';

const VN_TIMEZONE = 'Asia/Ho_Chi_Minh';

const getVNNow = (): Date => {
  return toZonedTime(new Date(), VN_TIMEZONE);
};

function formatCurrency(amount: number): string {
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    console.log('[WITHDRAW HANDLER] Request received, method:', req.method, 'url:', req.url, 'query:', req.query);
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const payload = await authMiddleware(req, res);
        if (!payload) return;

        await connectDB();

        const id = req.query.id || (req as any).params?.id;
        console.log('[WITHDRAW HANDLER] Extracted ID:', id);
        if (!id || typeof id !== 'string') {
            return res.status(400).json({ error: 'Transaction ID is required' });
        }

        const { amount, withdrawDate, actor } = req.body;
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Số tiền rút phải lớn hơn 0' });
        }

        const transaction = await (Transaction as any).findById(id);
        if (!transaction) {
            return res.status(404).json({ error: 'Không tìm thấy giao dịch' });
        }

        // Không cho rút nếu đã giải ngân hoàn toàn
        if (transaction.status === 'Đã giải ngân') {
            return res.status(400).json({ error: 'Giao dịch đã được giải ngân hoàn toàn' });
        }

        const project = await (Project as any).findById(transaction.projectId);
        const settings = await (Settings as any).findOne({ key: 'global' }) || { interestRate: 6.5 };
        const interestRate = settings.interestRate;
        const hasRateChange = settings.interestRateChangeDate && 
                               settings.interestRateBefore !== null && 
                               settings.interestRateBefore !== undefined &&
                               settings.interestRateAfter !== null && 
                               settings.interestRateAfter !== undefined;

        const now = getVNNow();
        
        // Xác định ngày rút tiền
        const withdrawDateVN = withdrawDate
            ? getVNStartOfDay(withdrawDate)
            : getVNStartOfDay(now);

        // Tính toán số tiền có thể rút
        // Nếu đã rút một phần trước đó, dùng principalForInterest làm gốc tính lãi
        // Điều này đảm bảo lãi kép được tính đúng trên phần còn lại
        const principalBase = transaction.principalForInterest ?? transaction.compensation.totalApproved;
        const baseDate = transaction.effectiveInterestDate || project?.interestStartDate;
        const baseDateVN = baseDate ? getVNStartOfDay(baseDate) : null;
        
        if (!baseDateVN) {
            return res.status(400).json({ error: 'Không có ngày bắt đầu tính lãi' });
        }

        // Tính lãi đến ngày rút (lãi kép như bình thường)
        let interest = 0;
        if (hasRateChange) {
            const interestResult = calculateInterestWithRateChange(
                principalBase,
                baseDateVN,
                withdrawDateVN,
                settings.interestRateChangeDate!,
                settings.interestRateBefore!,
                settings.interestRateAfter!
            );
            interest = interestResult.totalInterest;
        } else {
            interest = calculateInterest(
                principalBase,
                interestRate,
                baseDateVN,
                withdrawDateVN
            );
        }

        const supplementary = transaction.supplementaryAmount || 0;
        const totalAvailable = principalBase + interest + supplementary;

        // Validate số tiền rút
        if (amount > totalAvailable) {
            return res.status(400).json({ 
                error: `Số tiền rút (${formatCurrency(amount)}) vượt quá số tiền có thể rút (${formatCurrency(totalAvailable)})` 
            });
        }

        // Get organization và bank balance
        const org = project?.organization;
        if (!org) {
            return res.status(400).json({ error: 'Không tìm thấy thông tin tổ chức của dự án' });
        }

        const lastBankTx = await (BankTransaction as any).findOne({ organization: org }).sort({ _id: -1 });
        const settingsForBalance = await (Settings as any).findOne({ key: 'global' });
        const openingBalance = settingsForBalance?.bankOpeningBalance || 0;
        const currentBalance = lastBankTx?.runningBalance || openingBalance;

        // Xử lý theo 2 trường hợp:
        // 1. Rút hết tiền có thể rút -> Chuyển sang Đã giải ngân
        // 2. Rút một phần -> Chuyển sang Tồn đọng/Giữ hộ, lưu tiền còn lại và reset để tính lãi kép tiếp

        const withdrawDateUTC = withdrawDate ? fromVNTime(withdrawDateVN) : new Date();

        if (amount >= totalAvailable) {
            // TRƯỜNG HỢP 1: Rút hết -> Giải ngân hoàn toàn
            await (BankTransaction as any).create({
                type: 'Rút tiền',
                amount: -totalAvailable,
                date: withdrawDateUTC,
                note: `Chi trả dự án: ${project?.code} - Hộ: ${transaction.household.name}`,
                createdBy: actor || payload.name,
                runningBalance: currentBalance - totalAvailable,
                organization: org,
                projectId: project?._id
            });

            transaction.status = 'Đã giải ngân';
            transaction.disbursementDate = withdrawDateUTC;
            transaction.disbursedTotal = totalAvailable;
            // Clear các field partial withdrawal
            transaction.withdrawnAmount = undefined;
            transaction.remainingAfterWithdraw = undefined;
            transaction.principalForInterest = undefined;

            transaction.history.push({
                timestamp: withdrawDateVN,
                action: 'Rút tiền - Giải ngân hoàn toàn',
                details: `Rút toàn bộ số tiền có thể rút vào ngày ${formatTz(withdrawDateVN, 'dd/MM/yyyy', { timeZone: VN_TIMEZONE })}. Gốc: ${formatCurrency(principalBase)}, Lãi: ${formatCurrency(interest)}, Bổ sung: ${formatCurrency(supplementary)}, Tổng: ${formatCurrency(totalAvailable)}`,
                totalAmount: totalAvailable,
                actor: actor || payload.name
            });

        } else {
            // TRƯỜNG HỢP 2: Rút một phần -> Tồn đọng/Giữ hộ
            // Tiền còn lại sẽ tiếp tục tính lãi kép từ ngày rút
            const remaining = totalAvailable - amount;

            await (BankTransaction as any).create({
                type: 'Rút tiền',
                amount: -amount,
                date: withdrawDateUTC,
                note: `Rút một phần dự án: ${project?.code} - Hộ: ${transaction.household.name}`,
                createdBy: actor || payload.name,
                runningBalance: currentBalance - amount,
                organization: org,
                projectId: project?._id
            });

            transaction.status = 'Tồn đọng/Giữ hộ';
            transaction.withdrawnAmount = amount;
            transaction.remainingAfterWithdraw = remaining;
            // Set principalForInterest = remaining để tính lãi kép tiếp tục trên phần còn lại
            // Lãi sẽ được nhập vào gốc mỗi kỳ như các giao dịch bình thường
            transaction.principalForInterest = remaining;
            // Reset effectiveInterestDate để tính lãi từ ngày rút (lãi kép từ đây)
            transaction.effectiveInterestDate = withdrawDateVN;
            // Không set disbursementDate vì chưa giải ngân hoàn toàn
            transaction.disbursementDate = undefined;
            transaction.disbursedTotal = undefined;

            transaction.history.push({
                timestamp: withdrawDateVN,
                action: 'Rút tiền một phần',
                details: `Rút ${formatCurrency(amount)} vào ngày ${formatTz(withdrawDateVN, 'dd/MM/yyyy', { timeZone: VN_TIMEZONE })}. Tiền còn lại: ${formatCurrency(remaining)} (bao gồm cả lãi). Lãi kép sẽ tiếp tục tính trên số tiền còn lại từ ngày này.`,
                totalAmount: amount,
                actor: actor || payload.name
            });
        }

        await transaction.save();

        await (AuditLog as any).create({
            actor: actor || payload.name,
            role: payload.role,
            action: amount >= totalAvailable ? 'Rút tiền - Giải ngân hoàn toàn' : 'Rút tiền một phần',
            target: `Giao dịch ${transaction._id}`,
            details: `Rút ${formatCurrency(amount)} cho hộ ${transaction.household.name} vào ngày ${formatTz(withdrawDateVN, 'dd/MM/yyyy', { timeZone: VN_TIMEZONE })}`
        });

        // Reload transaction để trả về đầy đủ
        const updatedTransaction = await (Transaction as any).findById(id);
        const transactionData = updatedTransaction.toObject ? updatedTransaction.toObject({ virtuals: true }) : updatedTransaction;

        return res.status(200).json({ 
            success: true, 
            data: {
                ...transactionData,
                id: transactionData.id || transactionData._id?.toString()
            }
        });

    } catch (error: any) {
        console.error('Withdraw error:', error);
        return res.status(500).json({ error: 'Lỗi server: ' + error.message });
    }
}
