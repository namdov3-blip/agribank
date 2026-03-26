import { VercelRequest, VercelResponse } from '@vercel/node';
import connectDB from '../../../../lib/mongodb';
import { Transaction, Project, BankTransaction, AuditLog, Settings } from '../../../../lib/models';
import { verifyQRToken, authMiddleware } from '../../../../lib/auth';
import { toZonedTime } from 'date-fns-tz';
import { calculateInterest, calculateInterestWithRateChange, getVNStartOfDay } from '../../../../lib/utils/interest';
import { fromVNTime } from '../../../../utils/helpers';

const VN_TIMEZONE = 'Asia/Ho_Chi_Minh';

// Helper: Get current date/time in VN timezone
const getVNNow = (): Date => {
  return toZonedTime(new Date(), VN_TIMEZONE);
};

function formatCurrency(amount: number): string {
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        // No auth required for QR verification - public access allowed
        await connectDB();

        const token = req.query.token || req.query.id || (req as any).params?.token;
        if (!token || typeof token !== 'string') {
            return res.status(400).json({ error: 'Token is required' });
        }

        // Verify token
        const payload = verifyQRToken(token);
        if (!payload) {
            return res.status(400).json({ error: 'Token không hợp lệ hoặc đã hết hạn' });
        }

        const { transactionId, disbursementDate } = payload;

        const transaction = await (Transaction as any).findById(transactionId);
        if (!transaction) {
            return res.status(404).json({ error: 'Không tìm thấy giao dịch' });
        }

        // GET - Just return transaction info
        if (req.method === 'GET') {
            const project = await (Project as any).findById(transaction.projectId);
            const settings = await (Settings as any).findOne({ key: 'global' }) || { interestRate: 6.5 };
            const interestRate = settings.interestRate;
            const hasRateChange = settings.interestRateChangeDate &&
                settings.interestRateBefore !== null &&
                settings.interestRateBefore !== undefined &&
                settings.interestRateAfter !== null &&
                settings.interestRateAfter !== undefined;

            // Use disbursementDate embedded in QR token if available (from phiếu chi preview),
            // otherwise fall back to transaction.disbursementDate, then to "today" in VN timezone.
            const now = getVNNow();
            const interestEndDate = disbursementDate
                ? getVNStartOfDay(disbursementDate)
                : (transaction.disbursementDate
                    ? getVNStartOfDay(transaction.disbursementDate)
                    : getVNStartOfDay(now));

            const baseDate = transaction.effectiveInterestDate || project?.interestStartDate;
            const baseDateVN = baseDate ? getVNStartOfDay(baseDate) : null;
            
            if (!baseDateVN) {
                return res.status(400).json({ error: 'Không có ngày bắt đầu tính lãi' });
            }
            
            // Tính lãi với mốc thay đổi nếu đã cấu hình, giống với logic giải ngân thủ công
            let interest = 0;
            if (hasRateChange) {
                const interestResult = calculateInterestWithRateChange(
                    transaction.compensation.totalApproved,
                    baseDateVN,
                    interestEndDate,
                    settings.interestRateChangeDate!,
                    settings.interestRateBefore!,
                    settings.interestRateAfter!
                );
                interest = interestResult.totalInterest;
            } else {
                interest = calculateInterest(
                    transaction.compensation.totalApproved,
                    interestRate,
                    baseDateVN,
                    interestEndDate
                );
            }
            const supplementary = transaction.supplementaryAmount || 0;
            const totalAmount = transaction.compensation.totalApproved + interest + supplementary;

            return res.status(200).json({
                success: true,
                data: {
                    transactionId,
                    household: transaction.household.name,
                    cccd: transaction.household.cccd,
                    projectCode: project?.code,
                    projectName: project?.name,
                    status: transaction.status,
                    principal: transaction.compensation.totalApproved,
                    interest,
                    supplementary,
                    totalAmount,
                    canConfirm: transaction.status !== 'Đã giải ngân'
                }
            });
        }

        // POST - Confirm the transaction
        if (req.method === 'POST') {
            if (transaction.status === 'Đã giải ngân') {
                return res.status(400).json({ error: 'Giao dịch đã được giải ngân trước đó' });
            }

            const { confirmedBy } = req.body; // Name of person confirming

            const project = await (Project as any).findById(transaction.projectId);
            const settings = await (Settings as any).findOne({ key: 'global' }) || { interestRate: 6.5 };
            const interestRate = settings.interestRate;
            const hasRateChange = settings.interestRateChangeDate &&
                settings.interestRateBefore !== null &&
                settings.interestRateBefore !== undefined &&
                settings.interestRateAfter !== null &&
                settings.interestRateAfter !== undefined;

            const now = getVNNow();
            const baseDate = transaction.effectiveInterestDate || project?.interestStartDate;
            const baseDateVN = baseDate ? getVNStartOfDay(baseDate) : null;
            
            if (!baseDateVN) {
                return res.status(400).json({ error: 'Không có ngày bắt đầu tính lãi' });
            }

            // Sử dụng cùng ngày tính lãi như khi hiển thị phiếu chi/QR:
            // ưu tiên ngày được nhúng trong token QR, nếu không có thì dùng ngày giải ngân của giao dịch,
            // cuối cùng mới dùng ngày hiện tại.
            const interestEndDate = disbursementDate
                ? getVNStartOfDay(disbursementDate)
                : (transaction.disbursementDate
                    ? getVNStartOfDay(transaction.disbursementDate)
                    : getVNStartOfDay(now));

            // Tính lãi với mốc thay đổi nếu có cấu hình
            let interest = 0;
            if (hasRateChange) {
                const interestResult = calculateInterestWithRateChange(
                    transaction.compensation.totalApproved,
                    baseDateVN,
                    interestEndDate,
                    settings.interestRateChangeDate!,
                    settings.interestRateBefore!,
                    settings.interestRateAfter!
                );
                interest = interestResult.totalInterest;
            } else {
                interest = calculateInterest(
                    transaction.compensation.totalApproved,
                    interestRate,
                    baseDateVN,
                    interestEndDate
                );
            }
            const supplementary = transaction.supplementaryAmount || 0;
            const totalFinal = transaction.compensation.totalApproved + interest + supplementary;

            // Get current bank balance for this organization
            const org = project?.organization;
            if (!org) {
                return res.status(400).json({ error: 'Không tìm thấy thông tin tổ chức của dự án' });
            }

            const lastBankTx = await (BankTransaction as any).findOne({ organization: org }).sort({ _id: -1 });
            const settingsForBalance = await (Settings as any).findOne({ key: 'global' });
            const openingBalance = settingsForBalance?.bankOpeningBalance || 0;
            const currentBalance = lastBankTx?.runningBalance || openingBalance;

            // Determine disbursement date for storage:
            // convert VN start-of-day date to UTC if we used a specific disbursementDate,
            // otherwise use the current time.
            const disbursementDateVN = interestEndDate;
            const disbursementDateUTC = disbursementDate
                ? fromVNTime(disbursementDateVN)
                : new Date();

            // Create withdrawal (store as UTC, but use VN timezone for calculation)
            await (BankTransaction as any).create({
                type: 'Rút tiền',
                amount: -totalFinal,
                date: disbursementDateUTC,
                note: `Chi trả qua QR: ${project?.code} - Hộ: ${transaction.household.name}`,
                createdBy: confirmedBy || 'QR Scan',
                runningBalance: currentBalance - totalFinal,
                organization: org
            });


            // Update transaction (store as UTC, but use VN timezone for calculation)
            transaction.status = 'Đã giải ngân';
            transaction.disbursementDate = disbursementDateUTC;
            transaction.disbursedTotal = totalFinal; // Store the exact amount for refund
            transaction.history.push({
                timestamp: disbursementDateVN,
                action: 'Xác nhận chi trả qua QR',
                details: `Giải ngân qua quét mã QR. Tổng: ${formatCurrency(totalFinal)}`,
                totalAmount: totalFinal,
                actor: confirmedBy || 'QR Scan'
            });

            await transaction.save();

            await (AuditLog as any).create({
                actor: confirmedBy || 'QR Scan',
                role: 'QR Confirmation',
                action: 'Xác nhận chi trả qua QR',
                target: `Giao dịch ${transaction._id}`,
                details: `Giải ngân ${formatCurrency(totalFinal)} cho hộ ${transaction.household.name} qua mã QR`
            });

            return res.status(200).json({
                success: true,
                message: 'Xác nhận giao dịch thành công',
                data: {
                    transactionId,
                    household: transaction.household.name,
                    totalAmount: totalFinal,
                    disbursementDate: disbursementDateVN
                }
            });
        }

        return res.status(405).json({ error: 'Method not allowed' });

    } catch (error: any) {
        console.error('Confirm error:', error);
        return res.status(500).json({ error: 'Lỗi xác nhận: ' + error.message });
    }
}
