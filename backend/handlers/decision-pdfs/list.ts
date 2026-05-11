import { VercelRequest, VercelResponse } from '@vercel/node';
import connectDB from '../../../lib/mongodb';
import { DecisionPdfScan, User } from '../../../lib/models';
import { authMiddleware } from '../../../lib/auth';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const payload = await authMiddleware(req, res);
        if (!payload) return;

        await connectDB();
        const currentUser = await (User as any).findById(payload.userId);
        if (!currentUser) return res.status(401).json({ error: 'User not found' });

        const roleKey = (payload.role ?? '').trim().replace(/\s+/g, '').toLowerCase();
        const skipOrgNarrow =
            roleKey === 'superadmin' || roleKey === 'admin' || currentUser.organization === 'Nam World';

        const filter: Record<string, unknown> = {};
        if (!skipOrgNarrow && currentUser.organization) {
            filter.organization = currentUser.organization;
        }

        const rows = await (DecisionPdfScan as any)
            .find(filter)
            .select('organization originalFileName note sizeBytes createdAt uploadedBy')
            .populate('uploadedBy', 'name')
            .sort({ createdAt: -1 })
            .lean();

        const data = rows.map((r: any) => ({
            id: r._id.toString(),
            organization: r.organization,
            originalFileName: r.originalFileName,
            note: r.note || '',
            sizeBytes: r.sizeBytes,
            createdAt: r.createdAt,
            uploadedByName: r.uploadedBy?.name || '—'
        }));

        return res.status(200).json({ success: true, data });
    } catch (e: any) {
        console.error('decision-pdfs list:', e);
        return res.status(500).json({ error: e.message || 'Server error' });
    }
}
