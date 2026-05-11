import { VercelRequest, VercelResponse } from '@vercel/node';
import connectDB from '../../../lib/mongodb';
import { DecisionPdfScan, User, AuditLog } from '../../../lib/models';
import { authMiddleware } from '../../../lib/auth';
import { assertStaffMayMutate } from '../../../lib/mutation-policy';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const payload = await authMiddleware(req, res);
        if (!payload) return;
        if (!(await assertStaffMayMutate(payload, res))) return;

        let id = req.query.id || (req as any).params?.id;
        if (Array.isArray(id)) id = id[0];
        if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Thiếu id' });

        await connectDB();
        const currentUser = await (User as any).findById(payload.userId);
        if (!currentUser) return res.status(401).json({ error: 'User not found' });

        const roleKey = (payload.role ?? '').trim().replace(/\s+/g, '').toLowerCase();
        const skipOrgNarrow =
            roleKey === 'superadmin' || roleKey === 'admin' || currentUser.organization === 'Nam World';

        const doc = await (DecisionPdfScan as any).findById(id);
        if (!doc) return res.status(404).json({ error: 'Không tìm thấy file' });

        if (!skipOrgNarrow && currentUser.organization && doc.organization !== currentUser.organization) {
            return res.status(403).json({ error: 'Không có quyền xóa file này' });
        }

        await (DecisionPdfScan as any).deleteOne({ _id: doc._id });

        await (AuditLog as any).create({
            actor: payload.name,
            role: payload.role,
            action: 'Xóa PDF quyết định',
            target: `PDF ${id}`,
            details: doc.originalFileName || ''
        });

        return res.status(200).json({ success: true, message: 'Đã xóa' });
    } catch (e: any) {
        console.error('decision-pdfs delete:', e);
        return res.status(500).json({ error: e.message || 'Server error' });
    }
}
