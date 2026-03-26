import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Transaction, Project, User } from '../types';
import { formatCurrency, formatDateForPrint, formatCurrencyToWords, calculateInterest, calculateInterestWithRateChange, formatDate, getVNNow, getVNStartOfDay, fromVNTime, toVNTime, VN_TIMEZONE } from '../utils/helpers';
import { format as formatTz } from 'date-fns-tz';
import { Printer, Loader2, X, Edit2, Check } from 'lucide-react';
import { api } from '../services/api';

interface PrintPhieuChiProps {
    transaction: Transaction;
    project: Project | undefined;
    interestRate: number;
    interestRateChangeDate?: string | null;
    interestRateBefore?: number | null;
    interestRateAfter?: number | null;
    currentUser: User;
    onClose: () => void;
    onTransactionUpdated?: (transaction: Transaction) => void;
}

export const PrintPhieuChi: React.FC<PrintPhieuChiProps> = ({
    transaction,
    project,
    interestRate,
    interestRateChangeDate,
    interestRateBefore,
    interestRateAfter,
    currentUser,
    onClose,
    onTransactionUpdated
}) => {
    const [qrDataUrl, setQrDataUrl] = useState<string>('');
    const [isGenerating, setIsGenerating] = useState(true);
    const [printDateOverride, setPrintDateOverride] = useState<string>(''); // yyyy-mm-dd
    const [isEditingDisbursementDate, setIsEditingDisbursementDate] = useState(false);
    const [disbursementDateOverride, setDisbursementDateOverride] = useState<string>(''); // yyyy-mm-dd
    const [isSavingDisbursementDate, setIsSavingDisbursementDate] = useState(false);

    // Calculate amounts
    // Nếu đã rút một phần, dùng principalForInterest làm gốc tính lãi
    const principalBase = (transaction as any).principalForInterest ?? transaction.compensation.totalApproved;
    const baseDate = transaction.effectiveInterestDate || project?.interestStartDate;

    // Use disbursementDateOverride if set (for preview), otherwise use transaction.disbursementDate or today (VN timezone)
    const interestEndDate = disbursementDateOverride
        ? getVNStartOfDay(disbursementDateOverride)  // Use VN timezone for preview date
        : (transaction.disbursementDate 
            ? getVNStartOfDay(transaction.disbursementDate) 
            : getVNStartOfDay(getVNNow()));

    // Calculate interest with rate change if configured
    let interest = 0;
    let interestBefore = 0;
    let interestAfter = 0;
    let hasRateChange = false;

    if (interestRateChangeDate && interestRateBefore !== null && interestRateAfter !== null) {
        // Use rate change calculation
        const interestResult = calculateInterestWithRateChange(
            principalBase,
            baseDate,
            interestEndDate,
            interestRateChangeDate,
            interestRateBefore,
            interestRateAfter
        );
        interest = interestResult.totalInterest;
        interestBefore = interestResult.interestBefore;
        interestAfter = interestResult.interestAfter;
        hasRateChange = true;
    } else {
        // Use standard calculation
        interest = calculateInterest(principalBase, interestRate, baseDate, interestEndDate);
    }

    // Tính tổng tiền bổ sung từ history (vì sau khi bổ sung, supplementaryAmount có thể đã bị reset)
    const supplementaryFromHistory = transaction.history?.reduce((sum: number, h: any) => {
        if (h.action === 'Bổ sung tiền vào gốc' && h.totalAmount) {
            return sum + (h.totalAmount || 0);
        }
        return sum;
    }, 0) || 0;
    
    // Tiền phê duyệt ban đầu (gốc, chưa có tiền bổ sung)
    const originalTotalApproved = (transaction.compensation.totalApproved || 0) - supplementaryFromHistory;
    
    // Tiền bổ sung (từ history hoặc supplementaryAmount hiện tại nếu chưa được cộng vào totalApproved)
    const supplementary = supplementaryFromHistory > 0 
        ? supplementaryFromHistory 
        : (transaction.supplementaryAmount || 0);
    
    // Ensure totalAmount is always a valid number
    const totalAmount = Math.max(0, (principalBase || 0) + (interest || 0));
    
    // Thông tin rút tiền một phần
    const remainingAfterWithdraw = (transaction as any).remainingAfterWithdraw;
    const withdrawnAmount = (transaction as any).withdrawnAmount;
    
    // Tìm ngày rút tiền một phần từ history
    const withdrawHistoryEntry = transaction.history?.find((h: any) => 
        h.action === 'Rút tiền một phần' || h.action === 'Rút tiền - Giải ngân hoàn toàn'
    );
    const withdrawDateStr = withdrawHistoryEntry?.timestamp 
        ? formatDateForPrint(withdrawHistoryEntry.timestamp)
        : null;

    // Formatted strings for details
    const originalApprovedFormatted = formatCurrency(originalTotalApproved);
    const approvedFormatted = formatCurrency(transaction.compensation.totalApproved || 0);
    const interestFormatted = formatCurrency(interest || 0);
    const interestBeforeFormatted = formatCurrency(interestBefore || 0);
    const interestAfterFormatted = formatCurrency(interestAfter || 0);
    const supplementaryFormatted = formatCurrency(supplementary || 0);
    const totalFormatted = formatCurrency(totalAmount);

    // Ensure amountWords is always a valid string
    const amountWords = formatCurrencyToWords(totalAmount) || 'Không đồng';

    // Default: show "ngày giải ngân" if exists, else fallback to baseDate, else today (VN timezone)
    const effectiveDisbursementDateISO = disbursementDateOverride
        ? disbursementDateOverride + 'T00:00:00'
        : (transaction.disbursementDate || '');
    
    const defaultPrintDateISO =
        effectiveDisbursementDateISO ||
        (baseDate ? new Date(baseDate).toISOString() : getVNNow().toISOString());

    const effectivePrintDateISO = printDateOverride
        ? new Date(printDateOverride).toISOString()
        : defaultPrintDateISO;

    // Keep default editable GN date in sync when opening the preview / when transaction changes
    useEffect(() => {
        // If transaction has disbursementDate, use it; otherwise default to today's date in VN timezone
        // This ensures the date picker shows the correct date when opening preview
        let dateStr: string;
        if (transaction.disbursementDate) {
            const vnDate = toVNTime(transaction.disbursementDate);
            dateStr = formatTz(vnDate, 'yyyy-MM-dd', { timeZone: VN_TIMEZONE });
        } else {
            const todayVN = getVNNow();
            dateStr = formatTz(todayVN, 'yyyy-MM-dd', { timeZone: VN_TIMEZONE });
        }
        setDisbursementDateOverride(dateStr);
        setIsEditingDisbursementDate(false);
        setIsSavingDisbursementDate(false);
        setPrintDateOverride('');
    }, [transaction.id, transaction.disbursementDate]);

    const handleSaveDisbursementDate = async () => {
        if (!transaction.id || !disbursementDateOverride) return;
        setIsSavingDisbursementDate(true);
        try {
            // Convert VN timezone date string (yyyy-mm-dd) to UTC for storage
            // Create date string with VN timezone offset (+07:00) to ensure correct conversion
            const vnDateString = `${disbursementDateOverride}T00:00:00+07:00`;
            // Parse as VN timezone date and convert to UTC for storage
            const utcDate = new Date(vnDateString);
            
            const res = await api.transactions.update(transaction.id, {
                disbursementDate: utcDate.toISOString()
            });
            // Update parent (table/project views) so recalculated interest/total reflects immediately across the app.
            onTransactionUpdated?.(res.data as Transaction);
            setIsEditingDisbursementDate(false);
            
            // Regenerate QR code after saving disbursement date
            // This ensures QR reflects the updated transaction data
            if (transaction.status !== 'Đã giải ngân' && transaction.id) {
                setIsGenerating(true);
                try {
                    const qrRes = await api.transactions.getQR(transaction.id);
                    setQrDataUrl(qrRes.qrDataUrl);
                } catch (err) {
                    console.error('QR regeneration error after date update:', err);
                } finally {
                    setIsGenerating(false);
                }
            }
        } catch (err: any) {
            console.error('Update disbursementDate failed:', err);
            alert('Lỗi khi lưu ngày giải ngân: ' + (err?.message || 'Unknown error'));
        } finally {
            setIsSavingDisbursementDate(false);
        }
    };

    // Regenerate QR when disbursementDateOverride changes (with debounce to avoid too many calls)
    useEffect(() => {
        // Nếu giao dịch đã giải ngân thì không cần tạo QR nữa
        if (transaction.status === 'Đã giải ngân') {
            setIsGenerating(false);
            setQrDataUrl('');
            return;
        }

        // Debounce QR regeneration to avoid too many API calls
        const timeoutId = setTimeout(() => {
            const fetchQR = async () => {
                if (!transaction.id) return;

                setIsGenerating(true);
                try {
                    // If disbursementDateOverride is set, pass it as query parameter for QR calculation
                    // This allows QR to reflect the preview date without updating the transaction
                    // Add timestamp to prevent caching
                    const timestamp = Date.now();
                    const qrUrl = disbursementDateOverride 
                        ? `/api/transactions/${transaction.id}/qr?format=json&disbursementDate=${disbursementDateOverride}&_t=${timestamp}`
                        : `/api/transactions/${transaction.id}/qr?format=json&_t=${timestamp}`;
                    
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
                    
                    try {
                        const response = await fetch(qrUrl, { signal: controller.signal });
                        clearTimeout(timeoutId);
                        
                        if (!response.ok) {
                            // Check if it's a backend server error (503)
                            if (response.status === 503) {
                                // Backend server not running - silently fail
                                setQrDataUrl('');
                                return;
                            }
                            throw new Error('QR fetch failed');
                        }
                        
                        const res = await response.json();
                        setQrDataUrl(res.qrDataUrl);
                    } catch (fetchErr: any) {
                        clearTimeout(timeoutId);
                        // Check if it's a connection error (backend not running)
                        const isConnectionError = fetchErr.name === 'AbortError' ||
                                               fetchErr.message?.includes('Failed to fetch') ||
                                               fetchErr.message?.includes('ERR_EMPTY_RESPONSE') ||
                                               fetchErr.message?.includes('NetworkError');
                        
                        if (isConnectionError) {
                            // Backend server not running - silently fail without logging
                            setQrDataUrl('');
                            return;
                        }
                        // Only log non-connection errors
                        console.error('QR fetch error:', fetchErr);
                    }
                } catch (err) {
                    // Only log unexpected errors
                    const isConnectionError = (err as any)?.message?.includes('Failed to fetch') ||
                                           (err as any)?.message?.includes('ERR_EMPTY_RESPONSE');
                    if (!isConnectionError) {
                        console.error('QR fetch error:', err);
                    }
                } finally {
                    setIsGenerating(false);
                }
            };

            fetchQR();
        }, 500); // Debounce 500ms

        return () => clearTimeout(timeoutId);
    }, [transaction.id, transaction.status, transaction.disbursementDate, disbursementDateOverride]);

    const handlePrint = () => {
        window.print();
    };

    // Get organization info based on user
    const getOrgHeader = () => {
        const org = currentUser.organization || 'Đông Anh';
        const headers: Record<string, { name: string; address: string }> = {
            'Đông Anh': { name: 'UBND xã Đông Anh', address: 'Số 68 đường Cao Lỗ, xã Đông Anh, Hà Nội' },
            'Phúc Thịnh': { name: 'UBND xã Phúc Thịnh', address: 'Xã Phúc Thịnh, Hà Nội' },
            'Thiên Lộc': { name: 'UBND xã Thiên Lộc', address: 'Xã Thiên Lộc, Hà Nội' },
            'Thư Lâm': { name: 'UBND xã Thư Lâm', address: 'Xã Thư Lâm, Hà Nội' },
            'Vĩnh Thanh': { name: 'UBND xã Vĩnh Thanh', address: 'Xã Vĩnh Thanh, Hà Nội' }
        };
        return headers[org] || headers['Đông Anh'];
    };

    const orgInfo = getOrgHeader();

    const PhieuChiTemplate = () => (
        <div className="print-phieu-chi p-8 bg-white" style={{ fontFamily: 'Times New Roman, serif' }}>
            <style>{`
                @media print {
                    @page {
                        size: A4 portrait;
                        margin: 0;
                    }
                    
                    /* Hide everything in #root */
                    #root {
                        display: none !important;
                    }

                    /* Show print container */
                    html, body, #print-root {
                        display: block !important;
                        margin: 0 !important;
                        padding: 0 !important;
                        background: white !important;
                        height: auto !important;
                        overflow: visible !important;
                    }

                    .print-phieu-chi {
                        display: block !important;
                        position: absolute !important;
                        top: 0 !important;
                        left: 0 !important;
                        width: 210mm !important;
                        min-height: 297mm !important;
                        padding: 15mm !important;
                        margin: 0 !important;
                        background: white !important;
                        box-sizing: border-box !important;
                        font-size: 13pt !important;
                        z-index: 9999 !important;
                    }

                    .print-phieu-chi .flex { display: flex !important; }
                    .print-phieu-chi .justify-between { justify-content: space-between !important; }
                    .print-phieu-chi .items-start { align-items: flex-start !important; }
                    .print-phieu-chi .grid { display: grid !important; }
                    .print-phieu-chi .grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; }
                    .print-phieu-chi .text-center { text-align: center !important; }
                    .print-phieu-chi .font-bold { font-weight: bold !important; }
                    .print-phieu-chi .no-print { display: none !important; }
                }

                @media screen {
                    .print-phieu-chi {
                        width: 100%;
                        background: white;
                    }
                }
            `}</style>

            {/* Header */}
            <div className="flex justify-between items-start mb-6">
                <div className="border-2 border-black p-3" style={{ maxWidth: '280px' }}>
                    <p className="font-bold text-sm underline">{orgInfo.name}</p>
                    <p className="font-bold text-sm">Ban quản lý Dự án đầu tư – hạ tầng</p>
                    <p className="text-sm underline">{orgInfo.address}</p>
                </div>
                <div className="text-right">
                    <p className="font-bold text-sm">Mẫu số C41 - BB</p>
                </div>
            </div>

            {/* Title */}
            <div className="flex mb-6">
                <div className="flex-1 border-2 border-black p-4 text-center">
                    <h1 className="text-2xl font-bold mb-2">PHIẾU CHI</h1>
                    <p className="italic text-sm flex items-center justify-center gap-2">
                        <span className="print-only">{formatDateForPrint(effectivePrintDateISO)}</span>
                        <span className="no-print">
                            <input
                                type="date"
                                value={printDateOverride || effectivePrintDateISO.slice(0, 10)}
                                onChange={(e) => setPrintDateOverride(e.target.value)}
                                className="border border-slate-300 rounded px-2 py-1 text-xs font-semibold"
                                title="Sửa ngày hiển thị trên phiếu chi (chỉ ảnh hưởng bản in)"
                            />
                        </span>
                    </p>
                    <p className="text-sm">Số: {transaction.stt ?? '……'}</p>
                </div>
                <div className="border-2 border-black border-l-0 p-4 min-w-[220px]">
                    <div className="space-y-1 mt-2">
                        <div className="flex justify-between text-xs">
                            <span>- Tiền phê duyệt ban đầu:</span>
                            <span className="font-bold">{originalApprovedFormatted}</span>
                        </div>
                        {supplementary > 0 && (
                            <div className="flex justify-between text-xs">
                                <span>- Tiền bổ sung vào gốc:</span>
                                <span className="font-bold text-blue-600">+{supplementaryFormatted}</span>
                            </div>
                        )}
                        {supplementary > 0 && (
                            <div className="flex justify-between text-xs border-b border-slate-300 pb-1 mb-1">
                                <span className="font-semibold">= Tổng phê duyệt:</span>
                                <span className="font-bold">{approvedFormatted}</span>
                            </div>
                        )}
                        {hasRateChange ? (
                            <>
                                <div className="flex justify-between text-xs">
                                    <span>- Lãi (trước {interestRateChangeDate ? formatDate(interestRateChangeDate) : '01/01/2026'}):</span>
                                    <span className="font-bold">{interestBeforeFormatted}</span>
                                </div>
                                <div className="flex justify-between text-xs">
                                    <span>- Lãi (từ {interestRateChangeDate ? formatDate(interestRateChangeDate) : '01/01/2026'}):</span>
                                    <span className="font-bold">{interestAfterFormatted}</span>
                                </div>
                                <div className="flex justify-between text-xs border-t border-slate-300 pt-1">
                                    <span>- Tổng lãi:</span>
                                    <span className="font-bold">{interestFormatted}</span>
                                </div>
                            </>
                        ) : (
                            <div className="flex justify-between text-xs">
                                <span>- Lãi:</span>
                                <span className="font-bold">{interestFormatted}</span>
                            </div>
                        )}
                        {withdrawnAmount && withdrawnAmount > 0 && (
                            <div className="flex justify-between text-xs">
                                <span>- Số tiền đã rút:</span>
                                <span className="font-bold text-red-600">- {formatCurrency(withdrawnAmount)}</span>
                            </div>
                        )}
                        <div className="flex justify-between text-sm border-t border-black pt-1 mt-1">
                            <span className="font-bold">TỔNG CỘNG:</span>
                            <span className="font-bold text-red-600">{totalFormatted}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Recipient Info */}
            <div className="mb-4 space-y-2">
                <p className="text-sm">
                    Họ và tên người nhận tiền: <span className="font-bold">{transaction.household.name}</span>
                </p>
                <p className="text-sm">
                    Địa chỉ: <span className="border-b border-dotted border-black inline-block min-w-[400px]">
                        {transaction.household.address || ''}
                    </span>
                </p>
            </div>

            {/* Content */}
            <div className="mb-4 space-y-2">
                <p className="text-sm">
                    Nội dung: Chi trả tiền {transaction.paymentType || 'bồi thường, hỗ trợ GPMB'} theo quyết định số {transaction.household.decisionNumber} ngày {formatDate(transaction.household.decisionDate)}
                </p>
                <p className="text-sm">
                    thuộc dự án: {project?.name || 'N/A'} (Mã dự án: {project?.code || transaction.projectId})
                </p>
            </div>

            {/* Amount */}
            <div className="mb-4 space-y-1">
                <p className="text-sm">
                    Số tiền: <span className="font-bold">{totalFormatted}</span>
                </p>
                <p className="text-sm italic">
                    (Viết bằng chữ): <span className="capitalize">{amountWords.toLowerCase()} ./.</span>
                </p>
                <p className="text-sm">Kèm theo: Chứng từ liên quan</p>
            </div>

            {/* Confirmation Section */}
            <div className="mb-6 border-t border-black pt-4">
                <p className="font-bold mb-2">Đã nhận đủ số tiền</p>
                <p className="text-sm mb-1">- Bằng số: <span className="font-bold">{totalFormatted}</span></p>
                <p className="text-sm">- Bằng chữ: <span className="capitalize">{amountWords.toLowerCase()}</span></p>
            </div>

            {/* Tiền còn lại sau khi rút (nếu có) */}
            {remainingAfterWithdraw !== undefined && remainingAfterWithdraw > 0 && (
                <div className="mb-4 border-t border-slate-300 pt-4">
                    <p className="text-sm font-bold mb-1">Thông tin rút tiền:</p>
                    <p className="text-sm">
                        - Số tiền đã rút: <span className="font-bold">{formatCurrency(withdrawnAmount || 0)}</span>
                    </p>
                    <p className="text-sm">
                        - Tiền còn lại sau khi rút: <span className="font-bold text-red-600">{formatCurrency(remainingAfterWithdraw)}</span>
                    </p>
                    {withdrawDateStr && (
                        <p className="text-sm mt-1">
                            - Ngày rút tiền một phần: <span className="font-bold">{withdrawDateStr}</span>
                        </p>
                    )}
                    <p className="text-xs italic text-slate-600 mt-1">
                        (Lãi kép sẽ tiếp tục tính trên số tiền còn lại)
                    </p>
                </div>
            )}

            {/* Signatures with QR */}
            <div className="flex border-t-2 border-black pt-4">
                {/* Left signatures */}
                <div className="flex-1 grid grid-cols-3 gap-8">
                    <div className="text-center">
                        <p className="font-bold text-sm">Người lập biểu</p>
                        <p className="text-xs italic">(Ký, họ tên)</p>
                        <div className="h-16"></div>
                        <p className="text-sm font-semibold">{currentUser.name}</p>
                    </div>
                    <div className="text-center">
                        <p className="font-bold text-sm">Thủ quỹ</p>
                        <p className="text-xs italic">(Ký, họ tên)</p>
                        <div className="h-16"></div>
                        <p className="text-sm font-semibold">Nguyễn Hương Ly</p>
                    </div>
                    <div className="text-center">
                        <p className="italic text-xs mb-1">{formatDateForPrint(effectivePrintDateISO)}</p>
                        <p className="font-bold text-sm">Người nhận tiền</p>
                        <p className="text-xs italic">(Ký, họ tên)</p>
                        <div className="h-16"></div>
                    </div>
                </div>

                {/* QR Code - Right side */}
                <div className="ml-4 flex flex-col items-center justify-center border-l border-slate-300 pl-4">
                    {isGenerating ? (
                        <div className="w-[150px] h-[150px] flex items-center justify-center bg-slate-100">
                            <Loader2 size={24} className="animate-spin text-slate-400" />
                        </div>
                    ) : qrDataUrl ? (
                        <img src={qrDataUrl} alt="QR Code" className="w-[150px] h-[150px]" />
                    ) : (
                        <div className="w-[150px] h-[150px] flex items-center justify-center bg-slate-100 text-xs text-slate-400">
                            Không tạo được QR
                        </div>
                    )}
                    <p className="text-[10px] text-center mt-1 text-slate-500">Quét để xác nhận</p>
                </div>
            </div>
        </div>
    );

    const printRoot = document.getElementById('print-root');

    return (
        <>
            {/* Modal Overlay (Preview) */}
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 no-print">
                <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col">
                    <div className="flex justify-between items-center p-4 border-b bg-slate-50">
                        <h3 className="text-lg font-bold">Xem trước Phiếu chi</h3>
                        <div className="flex gap-2 items-center">
                            {/* Disbursement date editor (preview-only, hidden on print) */}
                            <div className="mr-2 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                                <span className="text-xs font-bold text-slate-600">
                                    Ngày giải ngân (tính lãi đến ngày này):
                                </span>
                                <input
                                    type="date"
                                    value={disbursementDateOverride}
                                    disabled={!isEditingDisbursementDate || isSavingDisbursementDate}
                                    onChange={(e) => setDisbursementDateOverride(e.target.value)}
                                    className={`border border-slate-300 rounded px-2 py-1 text-xs font-semibold ${!isEditingDisbursementDate ? 'bg-slate-100 text-slate-600' : ''}`}
                                />
                                {!isEditingDisbursementDate ? (
                                    <button
                                        onClick={() => setIsEditingDisbursementDate(true)}
                                        className="flex items-center gap-1 px-2 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100 rounded"
                                        title="Sửa ngày giải ngân (tính lãi đến ngày này)"
                                    >
                                        <Edit2 size={14} />
                                        Sửa
                                    </button>
                                ) : (
                                    <button
                                        onClick={handleSaveDisbursementDate}
                                        disabled={isSavingDisbursementDate}
                                        className="flex items-center gap-1 px-2 py-1 text-xs font-bold text-emerald-700 hover:bg-emerald-50 rounded disabled:opacity-60"
                                        title="Lưu ngày giải ngân vào hệ thống"
                                    >
                                        {isSavingDisbursementDate ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                                        Lưu
                                    </button>
                                )}
                            </div>

                            <button
                                onClick={handlePrint}
                                disabled={isGenerating}
                                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 transition-colors disabled:opacity-50"
                            >
                                {isGenerating ? <Loader2 size={16} className="animate-spin" /> : <Printer size={16} />}
                                In phiếu
                            </button>
                            <button onClick={onClose} className="p-2 hover:bg-slate-200 rounded-lg">
                                <X size={20} />
                            </button>
                        </div>
                    </div>

                    <div className="flex-1 overflow-auto bg-slate-100 p-8 flex justify-center">
                        <div className="w-[210mm] min-h-[297mm] bg-white shadow-lg p-[15mm] transform origin-top scale-[0.7] md:scale-90 lg:scale-100">
                            <PhieuChiTemplate />
                        </div>
                    </div>
                </div>
            </div>

            {/* Print Content (Portal) */}
            {printRoot && createPortal(<PhieuChiTemplate />, printRoot)}
        </>
    );
};
