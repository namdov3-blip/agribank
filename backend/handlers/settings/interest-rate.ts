import { VercelRequest, VercelResponse } from '@vercel/node';
import connectDB from '../../../lib/mongodb';
import { Settings, AuditLog } from '../../../lib/models';
import { authMiddleware } from '../../../lib/auth';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        await connectDB();

        // GET - Get current interest rate
        if (req.method === 'GET') {
            const payload = await authMiddleware(req, res);
            if (!payload) return;

            let settings = await (Settings as any).findOne({ key: 'global' });

            if (!settings) {
                settings = await (Settings as any).create({
                    key: 'global',
                    interestRate: 6.5,
                    interestHistory: [],
                    bankOpeningBalance: 0
                });
            }

            return res.status(200).json({
                success: true,
                data: {
                    interestRate: settings.interestRate,
                    bankInterestRate: settings.bankInterestRate ?? 0.5,
                    interestRateChangeDate: settings.interestRateChangeDate,
                    interestRateBefore: settings.interestRateBefore,
                    interestRateAfter: settings.interestRateAfter,
                    interestHistory: settings.interestHistory || []
                }
            });
        }

        // PUT - Update interest rate
        if (req.method === 'PUT') {
            const payload = await authMiddleware(req, res, ['Admin', 'SuperAdmin']);
            if (!payload) return;

            const { 
                interestRate, 
                interestRateChangeDate, 
                interestRateBefore, 
                interestRateAfter 
            } = req.body;

            // Validate interestRate if provided
            if (interestRate !== undefined && interestRate < 0) {
                return res.status(400).json({ error: 'Lãi suất không hợp lệ' });
            }

            // Validate rate change configuration
            if (interestRateChangeDate && (interestRateBefore === undefined || interestRateAfter === undefined)) {
                return res.status(400).json({ error: 'Phải cung cấp cả lãi suất trước và sau mốc thay đổi' });
            }

            let settings = await (Settings as any).findOne({ key: 'global' });
            const oldRate = settings?.interestRate || 6.5;

            if (!settings) {
                settings = new Settings({
                    key: 'global',
                    interestRate: interestRate || 6.5,
                    interestHistory: [],
                    bankOpeningBalance: 0
                });
            }

            // Update interest rate if provided
            if (interestRate !== undefined) {
                // Add to history only if rate actually changed
                if (settings.interestRate !== interestRate) {
                    settings.interestHistory.push({
                        timestamp: new Date(),
                        oldRate: settings.interestRate,
                        newRate: interestRate,
                        actor: payload.name
                    });
                }
                settings.interestRate = interestRate;
            }

            // Update rate change configuration
            if (interestRateChangeDate !== undefined) {
                settings.interestRateChangeDate = interestRateChangeDate ? new Date(interestRateChangeDate) : undefined;
            }
            if (interestRateBefore !== undefined) {
                settings.interestRateBefore = interestRateBefore;
            }
            if (interestRateAfter !== undefined) {
                settings.interestRateAfter = interestRateAfter;
            }

            await settings.save();

            // Create audit log
            const changes: string[] = [];
            if (interestRate !== undefined && settings.interestRate !== oldRate) {
                changes.push(`Lãi suất: ${oldRate}% → ${settings.interestRate}%`);
            }
            if (interestRateChangeDate !== undefined) {
                const changeDateStr = settings.interestRateChangeDate 
                    ? new Date(settings.interestRateChangeDate).toLocaleDateString('vi-VN')
                    : 'Không có';
                changes.push(`Mốc thay đổi: ${changeDateStr}`);
            }
            if (interestRateBefore !== undefined) {
                changes.push(`Lãi suất trước mốc: ${settings.interestRateBefore}%`);
            }
            if (interestRateAfter !== undefined) {
                changes.push(`Lãi suất sau mốc: ${settings.interestRateAfter}%`);
            }

            if (changes.length > 0) {
                await (AuditLog as any).create({
                    actor: payload.name,
                    role: payload.role,
                    action: 'Cập nhật cấu hình lãi suất',
                    target: 'Cấu hình hệ thống',
                    details: changes.join('; ')
                });
            }

            return res.status(200).json({
                success: true,
                data: {
                    interestRate: settings.interestRate,
                    bankInterestRate: settings.bankInterestRate ?? 0.5,
                    interestRateChangeDate: settings.interestRateChangeDate,
                    interestRateBefore: settings.interestRateBefore,
                    interestRateAfter: settings.interestRateAfter,
                    interestHistory: settings.interestHistory
                }
            });
        }

        return res.status(405).json({ error: 'Method not allowed' });

    } catch (error: any) {
        console.error('Settings error:', error);
        return res.status(500).json({ error: 'Lỗi server: ' + error.message });
    }
}

