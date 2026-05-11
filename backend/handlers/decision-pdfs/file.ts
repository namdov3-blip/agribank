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

        let id = req.query.id || (req as any).params?.id;
        if (Array.isArray(id)) id = id[0];
        if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Thiếu id' });

        await connectDB();
        const currentUser = await (User as any).findById(payload.userId);
        if (!currentUser) return res.status(401).json({ error: 'User not found' });

        const roleKey = (payload.role ?? '').trim().replace(/\s+/g, '').toLowerCase();
        const skipOrgNarrow =
            roleKey === 'superadmin' || roleKey === 'admin' || currentUser.organization === 'Nam World';

        const doc = await (DecisionPdfScan as any).findById(id).select('organization originalFileName pdfBuffer').lean();
        if (!doc) return res.status(404).json({ error: 'Không tìm thấy file' });

        if (!skipOrgNarrow && currentUser.organization && doc.organization !== currentUser.organization) {
            return res.status(403).json({ error: 'Không có quyền tải file này' });
        }

        const raw = doc.pdfBuffer;
        const pdfBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);

        const filename = encodeURIComponent(doc.originalFileName || 'quyet-dinh.pdf').replace(/'/g, '%27');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${filename}`);
        res.setHeader('Content-Length', String(pdfBuf.length));
        return res.status(200).send(pdfBuf);
    } catch (e: any) {
        console.error('decision-pdfs file:', e);
        return res.status(500).json({ error: e.message || 'Server error' });
    }
}
