import { VercelRequest, VercelResponse } from '@vercel/node';
import connectDB from '../../../lib/mongodb';
import { Transaction, Project, AuditLog, BankTransaction, User } from '../../../lib/models';
import { authMiddleware } from '../../../lib/auth';
import { toZonedTime, format as formatTz } from 'date-fns-tz';
import { getVNStartOfDay } from '../../../lib/utils/interest';
import { fromVNTime } from '../../../utils/helpers';

const VN_TIMEZONE = 'Asia/Ho_Chi_Minh';

function formatCurrency(amount: number): string {
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    console.log('[SUPPLEMENT HANDLER] Request received, method:', req.method, 'url:', req.url, 'query:', req.query);
    
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
        console.log('[SUPPLEMENT HANDLER] Extracted ID:', id);
        if (!id || typeof id !== 'string') {
            return res.status(400).json({ error: 'Transaction ID is required' });
        }

        const { amount, supplementDate, note, actor } = req.body;
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Số tiền bổ sung phải lớn hơn 0' });
        }

        const transaction = await (Transaction as any).findById(id);
        if (!transaction) {
            return res.status(404).json({ error: 'Không tìm thấy giao dịch' });
        }

        // Không cho bổ sung nếu đã giải ngân hoàn toàn
        if (transaction.status === 'Đã giải ngân') {
            return res.status(400).json({ error: 'Giao dịch đã được giải ngân hoàn toàn, không thể bổ sung tiền' });
        }

        const project = await (Project as any).findById(transaction.projectId);
        if (!project) {
            return res.status(404).json({ error: 'Không tìm thấy dự án liên quan' });
        }

        // Xác định ngày bổ sung tiền
        const supplementDateVN = supplementDate
            ? getVNStartOfDay(supplementDate)
            : getVNStartOfDay(new Date());

        // Cộng số tiền bổ sung vào tổng phê duyệt (gốc)
        const currentTotalApproved = transaction.compensation.totalApproved || 0;
        const newTotalApproved = currentTotalApproved + amount;

        // Get organization và bank balance
        const org = project?.organization;
        if (!org) {
            return res.status(400).json({ error: 'Không tìm thấy thông tin tổ chức của dự án' });
        }

        const lastBankTx = await (BankTransaction as any).findOne({ organization: org }).sort({ _id: -1 });
        const settingsForBalance = await (require('../../../lib/models').Settings as any).findOne({ key: 'global' });
        const openingBalance = settingsForBalance?.bankOpeningBalance || 0;
        const currentBalance = lastBankTx?.runningBalance || openingBalance;

        const supplementDateUTC = supplementDate ? fromVNTime(supplementDateVN) : new Date();

        // Tạo bank transaction
        await (BankTransaction as any).create({
            type: 'Nạp tiền',
            amount: amount,
            date: supplementDateUTC,
            note: `Bổ sung tiền vào gốc dự án: ${project?.code} - Hộ: ${transaction.household.name}${note ? `. ${note}` : ''}`,
            createdBy: actor || payload.name,
            runningBalance: currentBalance + amount,
            organization: org,
            projectId: project?._id
        });

        // Cập nhật transaction: cộng vào gốc và reset effectiveInterestDate
        transaction.compensation.totalApproved = newTotalApproved;
        transaction.effectiveInterestDate = supplementDateVN; // Reset để tính lãi từ ngày bổ sung
        // Clear supplementaryAmount vì đã cộng vào gốc rồi
        transaction.supplementaryAmount = 0;
        transaction.supplementaryNote = note || transaction.supplementaryNote;

        transaction.history.push({
            timestamp: supplementDateVN,
            action: 'Bổ sung tiền vào gốc',
            details: `Đã bổ sung ${formatCurrency(amount)} vào tổng phê duyệt vào ngày ${formatTz(supplementDateVN, 'dd/MM/yyyy', { timeZone: VN_TIMEZONE })}. Tổng phê duyệt mới: ${formatCurrency(newTotalApproved)}. Tính lãi bắt đầu từ ngày này.${note ? ` Ghi chú: ${note}` : ''}`,
            totalAmount: amount,
            actor: actor || payload.name
        });

        await transaction.save();

        await (AuditLog as any).create({
            actor: actor || payload.name,
            role: payload.role,
            action: 'Bổ sung tiền vào gốc',
            target: `Giao dịch ${transaction._id}`,
            details: `Bổ sung ${formatCurrency(amount)} vào tổng phê duyệt cho hộ ${transaction.household.name} vào ngày ${formatTz(supplementDateVN, 'dd/MM/yyyy', { timeZone: VN_TIMEZONE })}. Tổng phê duyệt mới: ${formatCurrency(newTotalApproved)}`
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
        console.error('Supplement error:', error);
        return res.status(500).json({ error: 'Lỗi server: ' + error.message });
    }
}
