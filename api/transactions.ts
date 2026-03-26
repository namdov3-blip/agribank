import { VercelRequest, VercelResponse } from '@vercel/node';
import transactionsIndex from '../backend/handlers/transactions/index';
import transactionsToken from '../backend/handlers/transactions/confirm/_token';
import transactionsStatus from '../backend/handlers/transactions/update-status';
import transactionsRefund from '../backend/handlers/transactions/refund';
import transactionsQR from '../backend/handlers/transactions/generate-qr';
import transactionsId from '../backend/handlers/transactions/_id';
import transactionsWithdraw from '../backend/handlers/transactions/withdraw';
import transactionsSupplement from '../backend/handlers/transactions/supplement';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    const { url } = req;
    const path = url?.split('?')[0] || '';
    
    console.log('[TRANSACTIONS ROUTER] Request received, method:', req.method, 'path:', path);

    // Transactions Index
    if (path === '/api/transactions' || path === '/api/transactions/') {
        return await transactionsIndex(req, res);
    }

    // Confirm Token
    if (path.includes('/confirm/')) {
        req.query.token = path.split('/')[4];
        return await transactionsToken(req, res);
    }

    // Status Update
    if (path.endsWith('/status')) {
        req.query.id = path.split('/')[3];
        return await transactionsStatus(req, res);
    }

    // Refund
    if (path.endsWith('/refund')) {
        req.query.id = path.split('/')[3];
        return await transactionsRefund(req, res);
    }

    // Withdraw - Must be checked before /:id route
    // Check both endsWith and includes to be safe
    if (path.endsWith('/withdraw') || path.includes('/withdraw')) {
        const parts = path.split('/');
        // Extract ID: /api/transactions/{id}/withdraw -> parts[3]
        const transactionId = parts[3];
        if (transactionId && transactionId !== 'withdraw') {
            req.query.id = transactionId;
            console.log('[TRANSACTIONS ROUTER] Matched /withdraw route, path:', path, 'id:', transactionId);
            return await transactionsWithdraw(req, res);
        }
    }

    // Supplement - Bổ sung tiền vào gốc
    if (path.endsWith('/supplement') || path.includes('/supplement')) {
        const parts = path.split('/');
        const transactionId = parts[3];
        if (transactionId && transactionId !== 'supplement') {
            req.query.id = transactionId;
            console.log('[TRANSACTIONS ROUTER] Matched /supplement route, path:', path, 'id:', transactionId);
            return await transactionsSupplement(req, res);
        }
    }

    // QR Code
    if (path.endsWith('/qr')) {
        req.query.id = path.split('/')[3];
        return await transactionsQR(req, res);
    }

    // Single Transaction (ID) - Must be checked LAST after all specific routes
    const parts = path.split('/');
    if (parts.length === 4 && parts[2] === 'transactions') {
        req.query.id = parts[3];
        return await transactionsId(req, res);
    }

    return res.status(404).json({ error: 'Transaction route not found: ' + path });
}
