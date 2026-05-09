import { VercelRequest, VercelResponse } from '@vercel/node';
import connectDB from '../../../lib/mongodb';
import { Settings, AuditLog, User } from '../../../lib/models';
import { authMiddleware } from '../../../lib/auth';
import { isElevatedRole } from '../../../lib/mutation-policy';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        await connectDB();

        // GET — mọi user đã đăng nhập (đọc cấu hình cho UI sidebar); chỉ PUT mới giới hạn elevated
        if (req.method === 'GET') {
            const payload = await authMiddleware(req, res);
            if (!payload) return;

            let settings = await (Settings as any).findOne({ key: 'global' });
            if (!settings) {
                settings = await (Settings as any).create({
                    key: 'global',
                    interestRate: 6.5,
                    interestHistory: [],
                    bankOpeningBalance: 0,
                    editingAllowed: true
                });
            }
            const editingAllowed = settings.editingAllowed !== false;
            return res.status(200).json({
                success: true,
                data: { editingAllowed }
            });
        }

        if (req.method !== 'PUT') {
            return res.status(405).json({ error: 'Method not allowed' });
        }

        const payload = await authMiddleware(req, res);
        if (!payload) return;

        const operator: any = await (User as any).findById(payload.userId).select('role permissions').lean();
        if (!operator) {
            return res.status(403).json({ error: 'Forbidden - Không tìm thấy tài khoản' });
        }
        const permList = Array.isArray(operator.permissions) ? operator.permissions : [];
        const hasAdminTab = permList.some((p: string) => String(p).trim().toLowerCase() === 'admin');
        const mayToggle = isElevatedRole(operator.role) || hasAdminTab;
        if (!mayToggle) {
            return res.status(403).json({
                error: 'Forbidden - Chỉ Admin / SuperAdmin / Kế toán trưởng hoặc user có quyền tab Admin mới chỉnh được khóa.'
            });
        }

        let nextFlag = req.body?.editingAllowed;
        if (typeof nextFlag === 'string') {
            const s = nextFlag.trim().toLowerCase();
            if (s === 'true' || s === '1') nextFlag = true;
            else if (s === 'false' || s === '0') nextFlag = false;
        }
        if (typeof nextFlag !== 'boolean') {
            return res.status(400).json({ error: 'editingAllowed phải là boolean (true/false)' });
        }
        const editingAllowed = nextFlag;

        let settings = await (Settings as any).findOne({ key: 'global' });
        if (!settings) {
            settings = await (Settings as any).create({
                key: 'global',
                interestRate: 6.5,
                interestHistory: [],
                bankOpeningBalance: 0,
                editingAllowed
            });
        } else {
            settings.editingAllowed = editingAllowed;
            await settings.save();
        }

        await (AuditLog as any).create({
            actor: payload.name,
            role: payload.role,
            action: editingAllowed ? 'Cho phép chỉnh sửa' : 'Khóa chỉnh sửa',
            target: 'Hệ thống',
            details: editingAllowed
                ? 'Đã bật chế độ cho phép user thường chỉnh sửa dữ liệu'
                : 'Đã tắt chế độ chỉnh sửa đối với user thường (User1/User2/PMB)'
        });

        return res.status(200).json({
            success: true,
            data: { editingAllowed: settings.editingAllowed !== false }
        });
    } catch (error: any) {
        console.error('editing-allowed error:', error);
        return res.status(500).json({ error: 'Lỗi server: ' + error.message });
    }
}
