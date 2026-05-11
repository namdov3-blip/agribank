import { VercelRequest, VercelResponse } from '@vercel/node';
import projectsIndex from '../backend/handlers/projects/index';
import projectsImport from '../backend/handlers/projects/import';
import projectsId from '../backend/handlers/projects/_id';
import approveTemplate from '../backend/handlers/projects/approve-template';
import transactionsLock from '../backend/handlers/projects/transactions-lock';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    const { url } = req;
    const path = url?.split('?')[0] || '';

    if (path === '/api/projects' || path === '/api/projects/') return await projectsIndex(req, res);
    if (path.endsWith('/import')) return await projectsImport(req, res);

    if (path.endsWith('/approve-template')) {
        const segments = path.split('/').filter(Boolean);
        const projectId = segments[segments.length - 2];
        if (projectId && segments[segments.length - 1] === 'approve-template') {
            req.query = { ...req.query, projectId };
            return await approveTemplate(req, res);
        }
    }

    if (path.endsWith('/transactions-lock')) {
        const segments = path.split('/').filter(Boolean);
        const projectId = segments[segments.length - 2];
        if (projectId && segments[segments.length - 1] === 'transactions-lock') {
            req.query = { ...req.query, projectId };
            return await transactionsLock(req, res);
        }
    }

    // Single Project (ID)
    const parts = path.split('/');
    if (parts.length === 4 && parts[2] === 'projects') {
        req.query.id = parts[3];
        return await projectsId(req, res);
    }

    return res.status(404).json({ error: 'Project route not found' });
}
