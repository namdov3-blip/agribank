import { VercelRequest, VercelResponse } from '@vercel/node';
import connectDB from '../../../lib/mongodb';
import { Project, User, AuditLog, Transaction, BankTransaction, Settings } from '../../../lib/models';
import { authMiddleware } from '../../../lib/auth';
import { isElevatedRole } from '../../../lib/mutation-policy';

/** POST — xóa toàn bộ GD staffImportPending của dự án; hoàn trừ NH; xóa dự án nếu không còn hồ sơ */
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

        if (!isElevatedRole(payload.role)) {
            return res.status(403).json({ error: 'Chỉ Kế toán trưởng / Admin / SuperAdmin được từ chối import/merge chờ duyệt' });
        }

        let id =
            req.query.projectId ||
            req.query.id ||
            (req as any).params?.id ||
            (req as any).params?.projectId;
        if (Array.isArray(id)) id = id[0];

        if (!id || typeof id !== 'string') {
            return res.status(400).json({ error: 'Thiếu mã dự án (id)' });
        }

        await connectDB();

        const currentUser = await (User as any).findById(payload.userId);
        if (!currentUser) {
            return res.status(400).json({ error: 'Không tìm thấy user' });
        }

        const project = await (Project as any).findById(id);
        if (!project) {
            return res.status(404).json({ error: 'Không tìm thấy dự án' });
        }

        const isAllOrg =
            payload.role === 'SuperAdmin' || currentUser.organization === 'Nam World';
        if (payload.role !== 'Admin' && !isAllOrg && currentUser.organization !== project.organization) {
            return res.status(403).json({ error: 'Không có quyền thao tác dự án đơn vị khác' });
        }

        if (payload.role === 'Admin' && !isAllOrg && currentUser.organization !== project.organization) {
            return res.status(403).json({ error: 'Không có quyền thao tác dự án đơn vị khác' });
        }

        const pending = await (Transaction as any).find({
            projectId: project._id,
            staffImportPending: true
        });

        if (!pending.length) {
            return res.status(400).json({
                error: 'Không có giao dịch import/merge đang chờ duyệt để từ chối.'
            });
        }

        const amountToReverse = pending.reduce(
            (sum: number, t: { compensation?: { totalApproved?: number } }) =>
                sum + (t.compensation?.totalApproved || 0),
            0
        );

        const org = project.organization as string | undefined;
        if (amountToReverse > 0 && org) {
            const lastBankTx = await (BankTransaction as any).findOne({ organization: org }).sort({ _id: -1 });
            const settings = await (Settings as any).findOne({ key: 'global' });
            const openingBalance = settings?.bankOpeningBalance || 0;
            const currentBalance = lastBankTx?.runningBalance ?? openingBalance;

            await (BankTransaction as any).create({
                type: 'Rút tiền',
                amount: -amountToReverse,
                date: new Date(),
                note: `Từ chối import/merge chờ duyệt — ${pending.length} hồ sơ dự án ${project.code}`,
                createdBy: payload.name,
                runningBalance: currentBalance - amountToReverse,
                organization: org,
                projectId: project._id,
                updatedAt: new Date()
            });
        }

        await (Transaction as any).deleteMany({
            projectId: project._id,
            staffImportPending: true
        });

        const remCount = await (Transaction as any).countDocuments({ projectId: project._id });

        if (remCount === 0) {
            await (Project as any).deleteOne({ _id: project._id });

            await (AuditLog as any).create({
                actor: payload.name,
                role: payload.role,
                action: 'Từ chối import/merge',
                target: `Dự án ${project.code}`,
                details: `Đã xóa ${pending.length} hồ sơ chờ duyệt; hoàn trừ quỹ ${amountToReverse.toLocaleString('vi-VN')} VND; xóa dự án vì không còn hồ sơ.`
            });

            return res.status(200).json({
                success: true,
                data: {
                    deletedProject: true,
                    removedCount: pending.length,
                    amountReversed: amountToReverse
                }
            });
        }

        const all = await (Transaction as any).find({ projectId: project._id });
        const newTotalBudget = all.reduce(
            (sum: number, t: { compensation?: { totalApproved?: number } }) =>
                sum + (t.compensation?.totalApproved || 0),
            0
        );
        project.totalBudget = newTotalBudget;
        project.updatedAt = new Date();
        await project.save();

        await (AuditLog as any).create({
            actor: payload.name,
            role: payload.role,
            action: 'Từ chối import/merge',
            target: `Dự án ${project.code}`,
            details: `Đã xóa ${pending.length} hồ sơ chờ duyệt; hoàn trừ quỹ ${amountToReverse.toLocaleString('vi-VN')} VND; ngân sách dự án còn: ${newTotalBudget.toLocaleString('vi-VN')} VND.`
        });

        const projectObj = project.toObject ? project.toObject({ virtuals: true }) : project;
        return res.status(200).json({
            success: true,
            data: {
                deletedProject: false,
                removedCount: pending.length,
                amountReversed: amountToReverse,
                totalBudget: newTotalBudget,
                project: {
                    ...projectObj,
                    id: (projectObj.id || projectObj._id || id).toString()
                }
            }
        });
    } catch (error: any) {
        console.error('reject-pending-import error:', error);
        return res.status(500).json({ error: 'Lỗi server: ' + error.message });
    }
}
