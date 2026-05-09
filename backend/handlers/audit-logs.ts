import { VercelRequest, VercelResponse } from '@vercel/node';
import connectDB from '../../lib/mongodb';
import { AuditLog, User } from '../../lib/models';
import { authMiddleware } from '../../lib/auth';
import { isElevatedRole, permissionsIncludeAdminTab } from '../../lib/mutation-policy';

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
        const payload = await authMiddleware(req, res);
        if (!payload) return;

        await connectDB();

        const operator: any = await (User as any).findById(payload.userId).select('role permissions').lean();
        if (!operator) {
            return res.status(403).json({ error: 'Forbidden — không tìm thấy tài khoản' });
        }
        const mayViewAudit =
            isElevatedRole(operator.role) || permissionsIncludeAdminTab(operator.permissions);
        if (!mayViewAudit) {
            return res.status(403).json({
                error: 'Forbidden — chỉ vai trò quản trị hoặc tài khoản có quyền Admin mới xem audit log.'
            });
        }

        const { page = '1', limit = '100', action, actor } = req.query;
        const pageNum = parseInt(page as string) || 1;
        const limitNum = parseInt(limit as string) || 100;
        const skip = (pageNum - 1) * limitNum;

        const filter: any = {};
        if (action) filter.action = { $regex: action, $options: 'i' };
        if (actor) filter.actor = { $regex: actor, $options: 'i' };

        const [logs, total] = await Promise.all([
            (AuditLog as any).find(filter)
                .sort({ timestamp: -1 })
                .skip(skip)
                .limit(limitNum),
            (AuditLog as any).countDocuments(filter)
        ]);

        return res.status(200).json({
            success: true,
            data: logs,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                pages: Math.ceil(total / limitNum)
            }
        });

    } catch (error: any) {
        console.error('Audit logs error:', error);
        return res.status(500).json({ error: 'Lỗi server: ' + error.message });
    }
}

