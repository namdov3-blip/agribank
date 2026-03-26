import { VercelRequest, VercelResponse } from '@vercel/node';
import connectDB from '../../../lib/mongodb';
import { Transaction, BankTransaction, AuditLog, Project, Settings } from '../../../lib/models';
import { authMiddleware } from '../../../lib/auth';
import { calculateInterest, getVNStartOfDay } from '../../../lib/utils/interest';
import { fromVNTime } from '../../../utils/helpers';
import { format as formatTz } from 'date-fns-tz';

const VN_TIMEZONE = 'Asia/Ho_Chi_Minh';

function formatCurrency(amount: number): string {
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
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
        if (!id || typeof id !== 'string') {
            return res.status(400).json({ error: 'Transaction ID is required' });
        }

        const { refundedAmount, refundDate } = req.body;
        if (!refundedAmount || refundedAmount <= 0) {
            return res.status(400).json({ error: 'Số tiền hoàn trả phải lớn hơn 0' });
        }

        // Get transaction to find project
        const transaction = await (Transaction as any).findById(id);
        if (!transaction) {
            return res.status(404).json({ error: 'Không tìm thấy giao dịch' });
        }

        const project = await (Project as any).findById(transaction.projectId);
        const org = project?.organization;
        if (!org) {
            return res.status(400).json({ error: 'Không tìm thấy thông tin tổ chức của dự án' });
        }

        // Xác định ngày nạp tiền
        const refundDateVN = refundDate
            ? getVNStartOfDay(refundDate)
            : getVNStartOfDay(new Date());
        const refundDateUTC = refundDate ? fromVNTime(refundDateVN) : new Date();

        // Get current bank balance for this organization
        const lastBankTx = await (BankTransaction as any).findOne({ organization: org }).sort({ _id: -1 });
        const settings = await (Settings as any).findOne({ key: 'global' }) || { interestRate: 6.5, bankOpeningBalance: 0 };
        const openingBalance = settings?.bankOpeningBalance || 0;
        const currentBalance = lastBankTx?.runningBalance || openingBalance;
        const interestRate = settings?.interestRate || 6.5;

        // Create deposit (refund)
        await (BankTransaction as any).create({
            type: 'Nạp tiền',
            amount: refundedAmount,
            date: refundDateUTC,
            note: `Hoàn quỹ hồ sơ: ${transaction._id} - Hộ: ${transaction.household.name}`,
            createdBy: payload.name,
            runningBalance: currentBalance + refundedAmount,
            organization: org,
            projectId: project?._id
        });

        // Calculate interest that was accrued up to disbursement date
        // This interest will be added to totalApproved when refunding
        
        let accruedInterest = 0;
        if (transaction.disbursementDate) {
            // Calculate interest from base date to disbursement date using bank method
            const baseDate = transaction.effectiveInterestDate || project?.interestStartDate;
            if (baseDate) {
                const disbursementDate = new Date(transaction.disbursementDate);
                accruedInterest = calculateInterest(
                    transaction.compensation.totalApproved,
                    interestRate,
                    baseDate,
                    disbursementDate
                );
            }
        }

        // Update transaction
        transaction.status = 'Tồn đọng/Giữ hộ';
        // Update totalApproved: new total = old total + accrued interest
        // This ensures that when refunding, the new principal includes the interest that was already paid
        transaction.compensation.totalApproved = transaction.compensation.totalApproved + accruedInterest;
        transaction.disbursementDate = undefined;
        // Set effectiveInterestDate to refundDateVN to reset interest calculation
        // Interest will start calculating from the refund date
        transaction.effectiveInterestDate = refundDateVN;
        transaction.supplementaryAmount = 0;
        transaction.supplementaryNote = undefined;
        // Clear disbursedTotal since we're refunding
        transaction.disbursedTotal = undefined;

        transaction.history.push({
            timestamp: refundDateVN,
            action: 'Nạp tiền / Hoàn quỹ',
            details: `Hoàn lại ${formatCurrency(refundedAmount)} vào ngày ${formatTz(refundDateVN, 'dd/MM/yyyy', { timeZone: VN_TIMEZONE })}. Tổng duyệt mới: ${formatCurrency(transaction.compensation.totalApproved)} (Gốc cũ + Lãi: ${formatCurrency(accruedInterest)}). Tính lãi bắt đầu từ ngày này.`,
            totalAmount: refundedAmount,
            actor: payload.name
        });

        await transaction.save();

        await (AuditLog as any).create({
            actor: payload.name,
            role: payload.role,
            action: 'Nạp tiền / Hoàn quỹ',
            target: `Giao dịch ${transaction._id}`,
            details: `Hoàn lại ${formatCurrency(refundedAmount)} cho hộ ${transaction.household.name}`
        });

        // Reload transaction to ensure all fields are properly serialized
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
        console.error('Refund error:', error);
        return res.status(500).json({ error: 'Lỗi server: ' + error.message });
    }
}
