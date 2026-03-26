import { VercelRequest, VercelResponse } from '@vercel/node';
import connectDB from '../../../lib/mongodb';
import { Transaction, Project, Settings } from '../../../lib/models';
import { generateQRToken } from '../../../lib/auth';
import QRCode from 'qrcode';
import { toZonedTime } from 'date-fns-tz';
import { calculateInterest, calculateInterestWithRateChange, getVNStartOfDay } from '../../../lib/utils/interest';

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
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        await connectDB();

        const id = req.query.id || (req as any).params?.id;
        const { format = 'json', disbursementDate: previewDate } = req.query;

        if (!id || typeof id !== 'string') {
            return res.status(400).json({ error: 'Transaction ID is required' });
        }

        const transaction = await (Transaction as any).findById(id);
        if (!transaction) {
            return res.status(404).json({ error: 'Không tìm thấy giao dịch' });
        }

        if (transaction.status === 'Đã giải ngân') {
            return res.status(400).json({ error: 'Giao dịch đã được giải ngân' });
        }

        const project = await (Project as any).findById(transaction.projectId);
        const settings = await (Settings as any).findOne({ key: 'global' }) || { interestRate: 6.5 };
        const interestRate = settings.interestRate;
        const hasRateChange = settings.interestRateChangeDate &&
            settings.interestRateBefore !== null &&
            settings.interestRateBefore !== undefined &&
            settings.interestRateAfter !== null &&
            settings.interestRateAfter !== undefined;

        // Calculate current amounts
        // Use previewDate (from query) if provided, otherwise use transaction.disbursementDate, otherwise use today (VN timezone)
        const now = getVNNow();
        const interestEndDate = previewDate && typeof previewDate === 'string'
            ? getVNStartOfDay(previewDate)  // Use preview date from query parameter
            : (transaction.disbursementDate 
                ? getVNStartOfDay(transaction.disbursementDate)
                : getVNStartOfDay(now));
        const baseDate = transaction.effectiveInterestDate || project?.interestStartDate;
        const baseDateVN = baseDate ? getVNStartOfDay(baseDate) : null;
        
        if (!baseDateVN) {
            return res.status(400).json({ error: 'Không có ngày bắt đầu tính lãi' });
        }
        
        // Tính lãi với mốc thay đổi nếu có cấu hình, giống với logic giải ngân thủ công và confirm QR
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

        // Generate secure token
        // If previewDate (disbursementDate override) is provided, embed it into the QR token
        // so that the confirm API can use the same date to compute interest as on the printed phiếu chi.
        const previewDateStr = previewDate && typeof previewDate === 'string' ? previewDate : undefined;
        const token = generateQRToken(id, previewDateStr);

        // Get frontend URL dynamically from request
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers.host;

        let frontendUrl = process.env.FRONTEND_URL;

        // If FRONTEND_URL is missing OR points to localhost while we are on a real host, reconstruct it
        if (!frontendUrl || (frontendUrl.includes('localhost') && host && !host.includes('localhost'))) {
            frontendUrl = `${protocol}://${host}`;
        }

        const confirmUrl = `${frontendUrl}/confirm/${token}`;

        // QR content should be JUST the URL for scanners to recognize it as a link
        const qrContent = confirmUrl;

        // Generate QR code as base64 image (Used by both JSON and Image formats)
        const qrDataUrlResult = await QRCode.toDataURL(qrContent, {
            width: 400,
            margin: 2,
            color: {
                dark: '#000000',
                light: '#FFFFFF'
            }
        });

        if (format === 'json') {
            return res.status(200).json({
                success: true,
                qrDataUrl: qrDataUrlResult,
                data: {
                    transactionId: id,
                    token,
                    confirmUrl,
                    household: transaction.household.name,
                    projectCode: project?.code,
                    principal: transaction.compensation.totalApproved,
                    interest,
                    supplementary,
                    totalAmount
                }
            });
        }

        // Return as binary image if explicitly requested
        if (format === 'image') {
            const base64 = qrDataUrlResult.replace(/^data:image\/png;base64,/, '');
            const buffer = Buffer.from(base64, 'base64');

            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Content-Length', buffer.length.toString());
            return res.status(200).send(buffer);
        }

        // Default: return JSON with base64 Data URL (Used by Frontend)
        return res.status(200).json({
            success: true,
            qrDataUrl: qrDataUrlResult,
            transactionId: id,
            token,
            confirmUrl,
            household: transaction.household.name,
            totalAmount
        });

    } catch (error: any) {
        console.error('QR generation error:', error);
        return res.status(500).json({ error: 'Lỗi tạo QR: ' + error.message });
    }
}
