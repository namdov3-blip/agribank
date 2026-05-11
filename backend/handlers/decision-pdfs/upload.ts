import { VercelRequest, VercelResponse } from '@vercel/node';
import connectDB from '../../../lib/mongodb';
import { DecisionPdfScan, User, AuditLog } from '../../../lib/models';
import { authMiddleware } from '../../../lib/auth';
import { assertStaffMayMutate } from '../../../lib/mutation-policy';

const MAX_BYTES = 14 * 1024 * 1024; // dưới giới hạn BSON 16MB

export default async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const payload = await authMiddleware(req, res);
        if (!payload) return;
        if (!(await assertStaffMayMutate(payload, res))) return;

        await connectDB();
        const currentUser = await (User as any).findById(payload.userId);
        if (!currentUser?.organization) {
            return res.status(400).json({ error: 'Tài khoản cần thuộc đơn vị để upload' });
        }

        const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
        const fileName = String(body.fileName || '').trim();
        const note = String(body.note || '').trim().slice(0, 500);
        const pdfBase64 = body.pdfBase64;

        if (!fileName) return res.status(400).json({ error: 'Thiếu tên file' });
        if (typeof pdfBase64 !== 'string' || !pdfBase64.length) {
            return res.status(400).json({ error: 'Thiếu nội dung PDF (pdfBase64)' });
        }

        const buf = Buffer.from(pdfBase64, 'base64');
        if (!buf.length) return res.status(400).json({ error: 'Dữ liệu PDF không hợp lệ' });
        if (buf.length > MAX_BYTES) {
            return res.status(400).json({ error: `File quá lớn (tối đa ${Math.floor(MAX_BYTES / 1024 / 1024)}MB)` });
        }
        if (buf.slice(0, 4).toString('ascii') !== '%PDF') {
            return res.status(400).json({ error: 'Chỉ chấp nhận file PDF hợp lệ' });
        }

        const doc = await (DecisionPdfScan as any).create({
            organization: currentUser.organization,
            uploadedBy: currentUser._id,
            originalFileName: fileName.replace(/[^\w.\-()\s\u00C0-\u024F]+/gi, '_').slice(0, 200),
            note,
            pdfBuffer: buf,
            sizeBytes: buf.length
        });

        await (AuditLog as any).create({
            actor: payload.name,
            role: payload.role,
            action: 'Upload PDF quyết định',
            target: `PDF ${doc._id}`,
            details: `File: ${fileName}, ${buf.length} bytes`
        });

        const lean = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
        return res.status(201).json({
            success: true,
            data: {
                id: lean._id?.toString() || doc._id.toString(),
                originalFileName: lean.originalFileName,
                note: lean.note,
                sizeBytes: lean.sizeBytes,
                createdAt: lean.createdAt
            }
        });
    } catch (e: any) {
        console.error('decision-pdfs upload:', e);
        return res.status(500).json({ error: e.message || 'Server error' });
    }
}
