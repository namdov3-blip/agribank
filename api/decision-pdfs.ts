import { VercelRequest, VercelResponse } from '@vercel/node';
import listHandler from '../backend/handlers/decision-pdfs/list';
import uploadHandler from '../backend/handlers/decision-pdfs/upload';
import fileHandler from '../backend/handlers/decision-pdfs/file';
import deleteHandler from '../backend/handlers/decision-pdfs/delete';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    const path = (req.url || '').split('?')[0] || '';

    if (path.endsWith('/file')) {
        const segments = path.split('/').filter(Boolean);
        const id = segments[segments.length - 2];
        if (id && segments[segments.length - 1] === 'file') {
            req.query = { ...req.query, id };
            return await fileHandler(req, res);
        }
    }

    if (path === '/api/decision-pdfs' || path === '/api/decision-pdfs/') {
        if (req.method === 'GET') return await listHandler(req, res);
        if (req.method === 'POST') return await uploadHandler(req, res);
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const parts = path.split('/').filter(Boolean);
    if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'decision-pdfs' && req.method === 'DELETE') {
        req.query = { ...req.query, id: parts[2] };
        return await deleteHandler(req, res);
    }

    return res.status(404).json({ error: 'decision-pdfs route not found' });
}
