import { VercelRequest, VercelResponse } from '@vercel/node';
import connectDB from '../../../lib/mongodb';
import { DecisionPdfScan, User } from '../../../lib/models';
import { authMiddleware } from '../../../lib/auth';

/** MongoDB/Mongoose có thể trả Buffer dưới dạng BSON Binary, Uint8Array hoặc { type:'Buffer', data }. */
function toPdfNodeBuffer(raw: unknown): Buffer {
    if (raw == null) return Buffer.alloc(0);
    if (Buffer.isBuffer(raw)) return raw;
    if (raw instanceof Uint8Array) return Buffer.from(raw);
    if (typeof raw === 'object') {
        const o = raw as Record<string, unknown>;
        if (o.type === 'Buffer' && Array.isArray(o.data)) {
            return Buffer.from(o.data as number[]);
        }
        if (o._bsontype === 'Binary' || o.sub_type !== undefined) {
            const bin = raw as { buffer?: Buffer | Uint8Array; value?: () => Uint8Array };
            if (Buffer.isBuffer(bin.buffer)) return Buffer.from(bin.buffer);
            if (bin.buffer instanceof Uint8Array) return Buffer.from(bin.buffer);
            if (typeof bin.value === 'function') {
                try {
                    return Buffer.from(bin.value());
                } catch {
                    /* fall through */
                }
            }
        }
    }
    return Buffer.alloc(0);
}

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

        // Không dùng .lean(): lean hay trả pdfBuffer dạng BSON Binary — Buffer.from() sẽ làm hỏng file PDF.
        const doc = await (DecisionPdfScan as any).findById(id).select('organization originalFileName pdfBuffer').exec();
        if (!doc) return res.status(404).json({ error: 'Không tìm thấy file' });

        if (!skipOrgNarrow && currentUser.organization && doc.organization !== currentUser.organization) {
            return res.status(403).json({ error: 'Không có quyền tải file này' });
        }

        const pdfBuf = toPdfNodeBuffer(doc.pdfBuffer);
        if (pdfBuf.length < 5 || pdfBuf.subarray(0, 4).toString('ascii') !== '%PDF') {
            console.error('decision-pdfs file: invalid PDF magic', { id, len: pdfBuf.length });
            return res.status(500).json({ error: 'Dữ liệu PDF trên máy chủ không hợp lệ' });
        }

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
