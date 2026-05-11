import { VercelRequest, VercelResponse } from '@vercel/node';
import connectDB from '../../../lib/mongodb';
import { Project, User, AuditLog } from '../../../lib/models';
import { authMiddleware } from '../../../lib/auth';
import { isElevatedRole } from '../../../lib/mutation-policy';

/** POST body: { locked: boolean } — chỉ KTT / Admin / SuperAdmin, cùng đơn vị với dự án (trừ Nam World / SuperAdmin). */
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
            return res.status(403).json({ error: 'Chỉ Kế toán trưởng / Admin / SuperAdmin được khóa/mở giao dịch dự án' });
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

        const body = req.body && typeof req.body === 'object' ? (req.body as { locked?: boolean }) : {};
        if (typeof body.locked !== 'boolean') {
            return res.status(400).json({ error: 'Thiếu trường locked (true/false)' });
        }
        const locked = body.locked;

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
            (payload.role ?? '').trim().replace(/\s+/g, '').toLowerCase() === 'superadmin' ||
            currentUser.organization === 'Nam World';
        if (payload.role !== 'Admin' && !isAllOrg && currentUser.organization !== project.organization) {
            return res.status(403).json({ error: 'Không có quyền thao tác dự án đơn vị khác' });
        }
        if (payload.role === 'Admin' && !isAllOrg && currentUser.organization !== project.organization) {
            return res.status(403).json({ error: 'Không có quyền thao tác dự án đơn vị khác' });
        }

        project.transactionsLocked = locked;
        await project.save();

        await (AuditLog as any).create({
            actor: payload.name,
            role: payload.role,
            action: locked ? 'Khóa giao dịch dự án' : 'Mở khóa giao dịch dự án',
            target: `Dự án ${project.code}`,
            details: locked
                ? `Đã khóa chỉnh sửa toàn bộ giao dịch — ${project.name}`
                : `Đã mở khóa chỉnh sửa giao dịch — ${project.name}`
        });

        const projectObj = project.toObject ? project.toObject({ virtuals: true }) : project;
        return res.status(200).json({
            success: true,
            data: {
                ...projectObj,
                id: (projectObj.id || projectObj._id || id).toString()
            }
        });
    } catch (error: any) {
        console.error('transactions-lock error:', error);
        return res.status(500).json({ error: 'Lỗi server: ' + error.message });
    }
}
