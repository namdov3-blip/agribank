import { VercelRequest, VercelResponse } from '@vercel/node';
import connectDB from '../../../lib/mongodb';
import { BankTransaction, Settings, AuditLog, User } from '../../../lib/models';
import { authMiddleware } from '../../../lib/auth';
import { assertStaffMayMutate, getStaffHiddenReportProjectIds } from '../../../lib/mutation-policy';
import mongoose from 'mongoose';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const payload = await authMiddleware(req, res);
        if (!payload) return;

        await connectDB();

        // Get user's organization for filtering
        const currentUser = await (User as any).findById(payload.userId);
        if (!currentUser) {
            return res.status(401).json({ error: 'User not found' });
        }

        // Build organization filter (JWT role có thể lệch hoa thường — giữ đúng quy tắc Admin/SuperNamWorld)
        const orgFilter: any = {};
        const roleKey = (payload.role ?? '').trim().replace(/\s+/g, '').toLowerCase();
        const skipOrgNarrow =
            roleKey === 'superadmin' || roleKey === 'admin' || currentUser.organization === 'Nam World';
        if (!skipOrgNarrow && currentUser.organization) {
            orgFilter.organization = currentUser.organization;
        }

        // GET - List bank transactions (filtered by org; bỏ dòng NH gắn dự án chờ duyệt — mọi role)
        if (req.method === 'GET') {
            const { page = '1', limit = '50' } = req.query;
            const pageNum = parseInt(page as string) || 1;
            const limitNum = parseInt(limit as string) || 50;
            const skip = (pageNum - 1) * limitNum;

            const mongoFilter: any = { ...orgFilter };
            const pendingIds = await getStaffHiddenReportProjectIds(payload, currentUser);
            const pendingObjIds = pendingIds.map((i: string) => new mongoose.Types.ObjectId(i));
            mongoFilter.$or = [
                { projectId: { $exists: false } },
                { projectId: null },
                { projectId: { $nin: pendingObjIds } }
            ];

            const [transactions, total] = await Promise.all([
                (BankTransaction as any).find(mongoFilter)
                    .sort({ _id: -1 })
                    .skip(skip)
                    .limit(limitNum),
                (BankTransaction as any).countDocuments(mongoFilter)
            ]);

            return res.status(200).json({
                success: true,
                data: transactions,
                pagination: {
                    page: pageNum,
                    limit: limitNum,
                    total,
                    pages: Math.ceil(total / limitNum)
                }
            });
        }

        // POST - Create new bank transaction
        if (req.method === 'POST') {
            if (!(await assertStaffMayMutate(payload, res))) return;

            const { type, amount, note, date, projectId } = req.body;

            if (!type || amount === undefined) {
                return res.status(400).json({ error: 'Loại giao dịch và số tiền là bắt buộc' });
            }

            // Robustly extract projectId if it's passed as an object (populated project)
            let finalProjectId = projectId;
            if (projectId && typeof projectId === 'object') {
                finalProjectId = projectId._id || projectId.id;
            }

            // Get current balance FOR THIS ORG
            const lastTx = await (BankTransaction as any).findOne(orgFilter).sort({ _id: -1 });
            const currentBalance = lastTx?.runningBalance || 0;

            // Calculate signed amount based on type
            let signedAmount = parseFloat(amount);
            if (type === 'Rút tiền' && signedAmount > 0) {
                signedAmount = -signedAmount;
            }

            const newBalance = currentBalance + signedAmount;

            const transaction = await (BankTransaction as any).create({
                type,
                amount: signedAmount,
                date: date ? new Date(date) : new Date(),
                note: note || '',
                createdBy: payload.name,
                runningBalance: newBalance,
                organization: currentUser.organization, // Set from current user
                projectId: finalProjectId || undefined,
                updatedAt: new Date()
            });

            return res.status(201).json({ success: true, data: transaction });
        }

        return res.status(405).json({ error: 'Method not allowed' });

    } catch (error: any) {
        console.error('Bank transactions error:', error);
        return res.status(500).json({ error: 'Lỗi server: ' + error.message });
    }
}

