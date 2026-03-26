
import React, { useState } from 'react';
import { Transaction, TransactionStatus, User, AuditLogItem, BankTransactionType, Project } from '../types';
import { formatCurrency, formatDate, formatDateForPrint, formatCurrencyToWords, calculateInterest, calculateInterestWithRateChange, formatNumberWithComma, parseNumberFromComma, toVNTime, fromVNTime, VN_TIMEZONE, roundTo2 } from '../utils/helpers';
import { format as formatTz } from 'date-fns-tz';
import { X, Wallet, FileText, CheckCircle, Clock, History, Scale, Printer, Undo2, ArrowDownCircle, Edit2, Save, Plus, Calendar, Loader2 } from 'lucide-react';
import { GlassCard } from './GlassCard';
import { StatusBadge } from './StatusBadge';
import { PrintPhieuChi } from './PrintPhieuChi';
import { api } from '../services/api';

interface TransactionModalProps {
  transaction: Transaction | null;
  project?: Project;
  interestRate: number;
  interestRateChangeDate?: string | null;
  interestRateBefore?: number | null;
  interestRateAfter?: number | null;
  onClose: () => void;
  onStatusChange: (id: string, status: TransactionStatus, disbursementDate?: string) => void;
  onRefund: (id: string, refundedAmount: number) => void;
  onUpdateTransaction: (transaction: Transaction) => void;
  currentUser: User;
  setAuditLogs: React.Dispatch<React.SetStateAction<AuditLogItem[]>>;
  handleAddBankTransaction: (type: BankTransactionType, amount: number, note: string, date: string, projectId?: string) => void;
}

export const TransactionModal: React.FC<TransactionModalProps> = ({
  transaction,
  project,
  interestRate,
  interestRateChangeDate,
  interestRateBefore,
  interestRateAfter,
  onClose,
  onStatusChange,
  onRefund,
  onUpdateTransaction,
  currentUser,
  setAuditLogs,
  handleAddBankTransaction
}) => {
  const [showHistory, setShowHistory] = useState(false);
  const [supplementaryAmount, setSupplementaryAmount] = useState(transaction?.supplementaryAmount || 0);
  const [supplementaryAmountInput, setSupplementaryAmountInput] = useState('');
  const [supplementaryNote, setSupplementaryNote] = useState(transaction?.supplementaryNote || '');
  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [editedTransaction, setEditedTransaction] = useState<Transaction | null>(null);
  const [localStatus, setLocalStatus] = useState(transaction?.status || TransactionStatus.PENDING);
  const [showPrintPreview, setShowPrintPreview] = useState(false);
  const [showPaymentDatePicker, setShowPaymentDatePicker] = useState(false);
  const [paymentDateInput, setPaymentDateInput] = useState<string>('');
  const [isSavingPaymentDate, setIsSavingPaymentDate] = useState(false);
  const [showWithdrawForm, setShowWithdrawForm] = useState(false);
  const [withdrawAmountInput, setWithdrawAmountInput] = useState('');
  const [withdrawDateInput, setWithdrawDateInput] = useState<string>('');
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [supplementaryDateInput, setSupplementaryDateInput] = useState<string>('');
  const [isSavingSupplementary, setIsSavingSupplementary] = useState(false);
  const [showRefundForm, setShowRefundForm] = useState(false);
  const [refundAmountInput, setRefundAmountInput] = useState('');
  const [refundDateInput, setRefundDateInput] = useState<string>('');
  const [isRefunding, setIsRefunding] = useState(false);

  if (!transaction) return null;

  // Initialize edited transaction
  React.useEffect(() => {
    if (transaction) {
      setEditedTransaction({ ...transaction });
      // Luôn reset box tiền bổ sung về 0 khi mở modal (theo yêu cầu: box reset = 0 sau khi lưu)
      setSupplementaryAmount(0);
      setSupplementaryAmountInput('');
      setSupplementaryNote('');
      setLocalStatus(transaction.status);
      
      // Initialize payment date input
      // Convert from UTC (stored in DB) to VN timezone for date input
      if (transaction.disbursementDate) {
        const vnDate = toVNTime(transaction.disbursementDate);
        const year = vnDate.getFullYear();
        const month = String(vnDate.getMonth() + 1).padStart(2, '0');
        const day = String(vnDate.getDate()).padStart(2, '0');
        setPaymentDateInput(`${year}-${month}-${day}`);
      } else {
        const todayVN = toVNTime(new Date());
        const year = todayVN.getFullYear();
        const month = String(todayVN.getMonth() + 1).padStart(2, '0');
        const day = String(todayVN.getDate()).padStart(2, '0');
        setPaymentDateInput(`${year}-${month}-${day}`);
      }
      
      // Init withdraw date input
      const todayVN = toVNTime(new Date());
      const year = todayVN.getFullYear();
      const month = String(todayVN.getMonth() + 1).padStart(2, '0');
      const day = String(todayVN.getDate()).padStart(2, '0');
      setWithdrawDateInput(`${year}-${month}-${day}`);
      
      // Init supplementary date input
      setSupplementaryDateInput(`${year}-${month}-${day}`);
      
      // Init refund date input
      setRefundDateInput(`${year}-${month}-${day}`);
    }
  }, [transaction]);

  const isDisbursed = localStatus === TransactionStatus.DISBURSED;
  const isHold = localStatus === TransactionStatus.HOLD;

  // Khi đang chỉnh "Chi tiết hồ sơ", sử dụng bản editedTransaction để tính toán realtime (bao gồm ngày GN mới)
  const effectiveTx = isEditingDetails && editedTransaction ? editedTransaction : transaction;

  // Tính lãi
  // Prioritize specific transaction interest date (e.g. refund date) over project default
  // Nếu đã rút một phần, dùng principalForInterest làm gốc tính lãi (để tính lãi kép trên phần còn lại)
  const principalBase = (effectiveTx as any).principalForInterest ?? effectiveTx.compensation.totalApproved;
  const baseDate = effectiveTx.effectiveInterestDate || project?.interestStartDate;

  let interest = 0;
  let calcEndDate = new Date();
  let storedDisbursedTotal = 0;

  const supplementary = effectiveTx.supplementaryAmount || 0;

  // For disbursed transactions, use the stored disbursedTotal field (most reliable)
  // or fall back to history entry
  if (isDisbursed) {
    if ((transaction as any).disbursedTotal) {
      storedDisbursedTotal = (transaction as any).disbursedTotal;
    } else if (transaction.history) {
      const disbursementEntry = [...transaction.history].reverse().find(
        (h: any) => h.action?.includes('Xác nhận') || h.action?.includes('chi trả')
      );
      if (disbursementEntry?.totalAmount) {
        storedDisbursedTotal = disbursementEntry.totalAmount;
      }
    }
  }

  // Calculate interest based on transaction status
  // Use rate change calculation if configured, otherwise use standard calculation
  let interestBefore = 0;
  let interestAfter = 0;
  const hasRateChange = interestRateChangeDate && interestRateBefore !== null && interestRateAfter !== null;

  if (isDisbursed && effectiveTx.disbursementDate) {
    // CASE 1: Đã giải ngân -> Lãi tính đến ngày thực tế chi trả (đóng băng)
    calcEndDate = new Date(effectiveTx.disbursementDate);
    if (hasRateChange) {
      const interestResult = calculateInterestWithRateChange(
        principalBase,
        baseDate,
        calcEndDate,
        interestRateChangeDate,
        interestRateBefore,
        interestRateAfter
      );
      interest = interestResult.totalInterest;
      interestBefore = interestResult.interestBefore;
      interestAfter = interestResult.interestAfter;
    } else {
      interest = calculateInterest(principalBase, interestRate, baseDate, calcEndDate);
    }
  } else if (!isDisbursed) {
    // CASE 2: Chưa giải ngân -> Nếu đã đặt ngày chi trả thì tính đến ngày đó (preview), nếu không thì tính đến hiện tại
    // Nếu đã rút một phần, principalBase sẽ là principalForInterest, và lãi sẽ tính kép trên phần còn lại
    if (effectiveTx.disbursementDate) {
      calcEndDate = new Date(effectiveTx.disbursementDate);
    } else {
      calcEndDate = new Date();
    }
    if (hasRateChange) {
      const interestResult = calculateInterestWithRateChange(
        principalBase,
        baseDate,
        calcEndDate,
        interestRateChangeDate,
        interestRateBefore,
        interestRateAfter
      );
      interest = interestResult.totalInterest;
      interestBefore = interestResult.interestBefore;
      interestAfter = interestResult.interestAfter;
    } else {
      interest = calculateInterest(principalBase, interestRate, baseDate, calcEndDate);
    }
  }

  // Với hồ sơ đã giải ngân:
  // - Nếu KHÔNG chỉnh sửa ngày GN, ưu tiên tổng tiền đã lưu (disbursedTotal) để khớp số liệu cũ.
  // - Nếu đang chỉnh ngày GN (editedTransaction khác với transaction), dùng lại calculatedTotal để thấy lãi/tổng tiền realtime.
  const calculatedTotal = principalBase + interest + supplementary;
  const hasEditedDisbursementDate =
    isEditingDetails &&
    editedTransaction &&
    editedTransaction.disbursementDate !== transaction.disbursementDate;

  const totalAmount =
    isDisbursed && storedDisbursedTotal > 0 && !hasEditedDisbursementDate
      ? storedDisbursedTotal
      : calculatedTotal;

  // Tính tiền còn lại sau khi rút (nếu đã rút một phần)
  const remainingAfterWithdraw = (transaction as any).remainingAfterWithdraw;

  // Display start date for interest logic (use baseDate directly without offset)
  const displayStartDate = baseDate ? new Date(baseDate) : null;

  const handleConfirmPaymentDate = async () => {
    if (!transaction.id || !paymentDateInput) {
      alert('Vui lòng chọn ngày chi trả');
      return;
    }

    setIsSavingPaymentDate(true);
    try {
      // Create date in VN timezone: paymentDateInput is "yyyy-mm-dd" format
      // Create date string with VN timezone offset (+07:00) to ensure correct conversion
      const vnDateString = `${paymentDateInput}T00:00:00+07:00`;
      // Parse as VN timezone date and convert to UTC for storage
      const vnDate = new Date(vnDateString);
      // Date is now in UTC (automatically converted from +07:00)
      const utcDate = vnDate;
      
      // Update disbursementDate via API
      const res = await api.transactions.update(transaction.id, {
        disbursementDate: utcDate.toISOString()
      });
      
      // Update parent component
      onUpdateTransaction(res.data as Transaction);
      setShowPaymentDatePicker(false);
      
      // Log audit
      const now = new Date();
      setAuditLogs(prev => [...prev, {
        id: `audit-${Date.now()}`,
        timestamp: now.toISOString(),
        actor: currentUser.name,
        role: currentUser.role,
        action: 'Xác nhận ngày chi trả',
        target: `Giao dịch ${transaction.id}`,
        details: `Đặt ngày chi trả: ${formatDate(utcDate.toISOString())} cho hộ ${transaction.household.name}`
      }]);
      
    } catch (err: any) {
      console.error('Update payment date failed:', err);
      alert('Lỗi khi lưu ngày chi trả: ' + (err?.message || 'Unknown error'));
    } finally {
      setIsSavingPaymentDate(false);
    }
  };

  const handleConfirmPayment = () => {
    if (!isDisbursed) {
      // Priority: 1) paymentDateInput (if user just changed it), 2) transaction.disbursementDate, 3) today
      let effectiveDisbursementDate: Date;
      if (paymentDateInput) {
        // Create date in VN timezone from "yyyy-mm-dd" format
        // Create date string with VN timezone offset (+07:00) to ensure correct conversion
        const vnDateString = `${paymentDateInput}T00:00:00+07:00`;
        // Parse as VN timezone date and convert to UTC for storage
        effectiveDisbursementDate = new Date(vnDateString);
      } else if (transaction.disbursementDate) {
        effectiveDisbursementDate = new Date(transaction.disbursementDate);
      } else {
        effectiveDisbursementDate = new Date();
      }
      
      // Use the set disbursementDate if available, otherwise calculate to today
      // Nếu đã rút một phần, dùng principalForInterest làm gốc tính lãi
      const principalBaseForConfirm = (transaction as any).principalForInterest ?? transaction.compensation.totalApproved;
      const baseDate = transaction.effectiveInterestDate || project?.interestStartDate;
      const calcEndDate = effectiveDisbursementDate;

      // Tính lãi giống backend (hỗ trợ mốc thay đổi lãi suất nếu có)
      let interestForConfirm = 0;
      if (hasRateChange) {
        const interestResult = calculateInterestWithRateChange(
          principalBaseForConfirm,
          baseDate,
          calcEndDate,
          interestRateChangeDate!,
          interestRateBefore!,
          interestRateAfter!
        );
        interestForConfirm = interestResult.totalInterest;
      } else {
        interestForConfirm = calculateInterest(
          principalBaseForConfirm,
          interestRate,
          baseDate,
          calcEndDate
        );
      }

      // Chuẩn hóa làm tròn về 2 chữ số để hiển thị khớp với phiếu/QR
      interestForConfirm = roundTo2(interestForConfirm);
      const supplementary = transaction.supplementaryAmount || 0;
      const calculatedTotal = roundTo2(principalBaseForConfirm + interestForConfirm + supplementary);

      const dateDisplay = formatDate(effectiveDisbursementDate.toISOString());

      const confirmMsg = `Xác nhận CHI TRẢ cho hộ dân "${transaction.household.name}"?\n\n` +
        `- Ngày chi trả: ${dateDisplay}\n` +
        `- Số tiền: ${formatCurrency(calculatedTotal)}\n` +
        `  (Gốc: ${formatCurrency(principalBaseForConfirm)} + Lãi: ${formatCurrency(interestForConfirm)} + Bổ sung: ${formatCurrency(supplementary)})\n\n` +
        `Thao tác này sẽ trừ tiền từ quỹ và không thể hoàn tác trực tiếp.`;

      if (window.confirm(confirmMsg)) {
        // Pass the effective disbursementDate (from paymentDateInput or transaction.disbursementDate)
        const dateToPass = effectiveDisbursementDate.toISOString();
        onStatusChange(transaction.id, TransactionStatus.DISBURSED, dateToPass);
        setLocalStatus(TransactionStatus.DISBURSED);
      }
    }
  };

  const handleRefundMoney = async () => {
    const parsedAmount = parseNumberFromComma(refundAmountInput);
    if (parsedAmount <= 0) {
      alert('Vui lòng nhập số tiền muốn nạp lớn hơn 0');
      return;
    }

    if (!refundDateInput) {
      alert('Vui lòng chọn ngày nạp tiền');
      return;
    }

    // Validate số tiền nạp không vượt quá tổng đã giải ngân
    if (parsedAmount > totalAmount) {
      alert(`Số tiền nạp (${formatCurrency(parsedAmount)}) không được vượt quá tổng đã giải ngân (${formatCurrency(totalAmount)})`);
      return;
    }

    // Create date in VN timezone: refundDateInput is "yyyy-mm-dd" format
    const vnDateString = `${refundDateInput}T00:00:00+07:00`;
    const vnDate = new Date(vnDateString);
    const utcDate = vnDate; // Automatically converted from +07:00 to UTC

    const confirmMsg = `Xác nhận nạp lại ${formatCurrency(parsedAmount)} vào quỹ?\n\n` +
      `- Ngày nạp: ${formatDate(utcDate.toISOString())}\n` +
      `- Số tiền: ${formatCurrency(parsedAmount)}\n` +
      `- Gốc mới: ${formatCurrency(parsedAmount)}\n` +
      `- Lãi: Reset về 0\n` +
      `- Trạng thái: Tồn đọng/Giữ hộ\n` +
      `- Bắt đầu tính lãi: Từ ngày ${formatDate(utcDate.toISOString())}`;

    if (!window.confirm(confirmMsg)) return;

    try {
      setIsRefunding(true);
      // Gọi API refund với ngày nạp tiền
      const res = await api.transactions.refund(
        transaction.id, 
        parsedAmount, 
        utcDate.toISOString(),
        currentUser.name
      );
      onUpdateTransaction(res.data as Transaction);
      setLocalStatus(TransactionStatus.HOLD);
      setShowRefundForm(false);
      setRefundAmountInput('');
      setShowHistory(true);
      
      // Log audit
      setAuditLogs(prev => [...prev, {
        id: `audit-${Date.now()}`,
        timestamp: utcDate.toISOString(),
        actor: currentUser.name,
        role: currentUser.role,
        action: 'Nạp tiền / Hoàn quỹ',
        target: `Giao dịch ${transaction.id}`,
        details: `Nạp lại ${formatCurrency(parsedAmount)} vào quỹ cho hộ ${transaction.household.name} vào ngày ${formatDate(utcDate.toISOString())}`
      }]);
      
      // Sau khi nạp tiền, trạng thái sẽ tự động chuyển sang HOLD và nút nạp tiền sẽ mất
    } catch (err: any) {
      console.error('Refund failed:', err);
      alert('Lỗi khi nạp tiền: ' + (err?.message || 'Unknown error'));
    } finally {
      setIsRefunding(false);
    }
  };

  const handleWithdraw = async () => {
    const parsedAmount = parseNumberFromComma(withdrawAmountInput);
    if (parsedAmount <= 0) {
      alert('Vui lòng nhập số tiền muốn rút lớn hơn 0');
      return;
    }

    // Tính tổng có thể rút (dùng principalBase để hỗ trợ partial withdrawal)
    const principalBase = (transaction as any).principalForInterest ?? transaction.compensation.totalApproved;
    const baseDate = transaction.effectiveInterestDate || project?.interestStartDate;
    
    if (!baseDate) {
      alert('Không có ngày bắt đầu tính lãi');
      return;
    }

    let interestForWithdraw = 0;
    const withdrawDate = withdrawDateInput ? new Date(`${withdrawDateInput}T00:00:00+07:00`) : new Date();
    
    if (hasRateChange) {
      const interestResult = calculateInterestWithRateChange(
        principalBase,
        baseDate,
        withdrawDate,
        interestRateChangeDate!,
        interestRateBefore!,
        interestRateAfter!
      );
      interestForWithdraw = interestResult.totalInterest;
    } else {
      interestForWithdraw = calculateInterest(principalBase, interestRate, baseDate, withdrawDate);
    }

    const supplementary = transaction.supplementaryAmount || 0;
    const totalAvailable = principalBase + interestForWithdraw + supplementary;

    if (parsedAmount > totalAvailable) {
      alert(`Số tiền rút (${formatCurrency(parsedAmount)}) vượt quá số tiền có thể rút (${formatCurrency(totalAvailable)})`);
      return;
    }

    const remaining = totalAvailable - parsedAmount;
    const isFullWithdraw = parsedAmount >= totalAvailable;

    const confirmMsg = isFullWithdraw
      ? `Xác nhận RÚT TOÀN BỘ ${formatCurrency(totalAvailable)}?\n\n` +
        `- Ngày rút: ${formatDate(withdrawDate.toISOString())}\n` +
        `- Gốc: ${formatCurrency(principalBase)}\n` +
        `- Lãi: ${formatCurrency(interestForWithdraw)}\n` +
        `- Bổ sung: ${formatCurrency(supplementary)}\n\n` +
        `Giao dịch sẽ chuyển sang trạng thái "Đã giải ngân".`
      : `Xác nhận RÚT MỘT PHẦN ${formatCurrency(parsedAmount)}?\n\n` +
        `- Ngày rút: ${formatDate(withdrawDate.toISOString())}\n` +
        `- Tiền còn lại: ${formatCurrency(remaining)} (bao gồm cả lãi)\n` +
        `- Lãi kép sẽ tiếp tục tính trên số tiền còn lại\n` +
        `- Giao dịch sẽ chuyển sang trạng thái "Tồn đọng/Giữ hộ"`;

    if (!window.confirm(confirmMsg)) return;

    try {
      setIsWithdrawing(true);
      const res = await api.transactions.withdraw(
        transaction.id,
        parsedAmount,
        withdrawDateInput || undefined,
        currentUser.name
      );

      onUpdateTransaction(res.data as Transaction);
      setLocalStatus(res.data.status as TransactionStatus);
      setShowWithdrawForm(false);
      setWithdrawAmountInput('');

      // Log audit
      const now = new Date();
      setAuditLogs(prev => [...prev, {
        id: `audit-${Date.now()}`,
        timestamp: now.toISOString(),
        actor: currentUser.name,
        role: currentUser.role,
        action: isFullWithdraw ? 'Rút tiền - Giải ngân hoàn toàn' : 'Rút tiền một phần',
        target: `Giao dịch ${transaction.id}`,
        details: `Rút ${formatCurrency(parsedAmount)} cho hộ ${transaction.household.name}`
      }]);
    } catch (err: any) {
      console.error('Withdraw failed:', err);
      alert('Lỗi khi rút tiền: ' + (err?.message || 'Unknown error'));
    } finally {
      setIsWithdrawing(false);
    }
  };

  const handleSaveSupplementary = async () => {
    const parsedAmount = parseNumberFromComma(supplementaryAmountInput);
    if (parsedAmount <= 0) {
      alert('Vui lòng nhập số tiền bổ sung lớn hơn 0');
      return;
    }

    if (!supplementaryDateInput) {
      alert('Vui lòng chọn ngày bổ sung');
      return;
    }

    // Create date in VN timezone: supplementaryDateInput is "yyyy-mm-dd" format
    const vnDateString = `${supplementaryDateInput}T00:00:00+07:00`;
    const vnDate = new Date(vnDateString);
    const utcDate = vnDate; // Automatically converted from +07:00 to UTC

    // Cộng số tiền bổ sung vào gốc (tổng phê duyệt)
    const newTotalApproved = (transaction.compensation.totalApproved || 0) + parsedAmount;

    // Popup confirmation
    const confirmMsg = `Xác nhận BỔ SUNG TIỀN VÀO GỐC?\n\n` +
      `- Ngày bổ sung: ${formatDate(utcDate.toISOString())}\n` +
      `- Số tiền bổ sung: ${formatCurrency(parsedAmount)}\n` +
      `- Tổng phê duyệt hiện tại: ${formatCurrency(transaction.compensation.totalApproved || 0)}\n` +
      `- Tổng phê duyệt mới: ${formatCurrency(newTotalApproved)}\n` +
      `- Tính lãi bắt đầu từ: ${formatDate(utcDate.toISOString())}\n\n` +
      `Lưu ý: Số tiền này sẽ được cộng vào tổng phê duyệt và lãi sẽ tính từ ngày bổ sung.`;

    if (!window.confirm(confirmMsg)) return;

    try {
      setIsSavingSupplementary(true);

      // Safely extract project ID if it's an object/populated
      let finalProjectId = transaction.projectId;
      if (finalProjectId && typeof finalProjectId === 'object') {
        finalProjectId = (finalProjectId as any).id || (finalProjectId as any)._id || finalProjectId;
      }

      // Gọi API supplement để bổ sung tiền vào gốc
      const res = await api.transactions.supplement(
        transaction.id,
        parsedAmount,
        supplementaryDateInput,
        supplementaryNote || undefined,
        currentUser.name
      );

      // Update parent component
      onUpdateTransaction(res.data as Transaction);

      // Log audit
      setAuditLogs(prev => [...prev, {
        id: `audit-${Date.now()}`,
        timestamp: utcDate.toISOString(),
        actor: currentUser.name,
        role: currentUser.role,
        action: 'Bổ sung tiền vào gốc',
        target: `Giao dịch ${transaction.id}`,
        details: `Bổ sung ${formatCurrency(parsedAmount)} vào tổng phê duyệt cho hộ ${transaction.household.name}. Tổng phê duyệt mới: ${formatCurrency(newTotalApproved)}. Tính lãi từ ngày ${formatDate(utcDate.toISOString())}${supplementaryNote ? `. Ghi chú: ${supplementaryNote}` : ''}`
      }]);

      // Reset box sau khi lưu
      setSupplementaryAmount(0);
      setSupplementaryAmountInput('');
      setSupplementaryNote('');
      
      alert(`Đã bổ sung ${formatCurrency(parsedAmount)} vào tổng phê duyệt. Tổng phê duyệt mới: ${formatCurrency(newTotalApproved)}. Lãi sẽ tính từ ngày ${formatDate(utcDate.toISOString())}.`);
    } catch (err: any) {
      console.error('Bổ sung tiền thất bại:', err);
      alert('Lỗi khi bổ sung tiền: ' + (err?.message || 'Unknown error'));
    } finally {
      setIsSavingSupplementary(false);
    }
  };

  const handleSaveDetails = () => {
    if (editedTransaction) {
      const now = new Date();
      const updated = {
        ...editedTransaction,
        history: [
          ...(transaction.history || []),
          {
            timestamp: now.toISOString(),
            action: 'Cập nhật thông tin',
            details: 'Đã chỉnh sửa thông tin hồ sơ',
            actor: currentUser.name
          }
        ]
      };
      onUpdateTransaction(updated);
      setIsEditingDetails(false);

      // Log audit
      setAuditLogs(prev => [...prev, {
        id: `audit-${Date.now()}`,
        timestamp: now.toISOString(),
        actor: currentUser.name,
        role: currentUser.role,
        action: 'Cập nhật thông tin',
        target: `Giao dịch ${transaction.id}`,
        details: `Cập nhật thông tin hồ sơ ${transaction.household.name}`
      }]);
    }
  };

  const handlePrint = () => {
    setShowPrintPreview(true);
  };

  // State for secure QR code
  const [qrUrl, setQrUrl] = useState<string>('');

  // Fetch secure QR Code URL using the API
  // Only fetch QR for transactions that are NOT yet disbursed
  React.useEffect(() => {
    if (transaction?.id && transaction.status !== TransactionStatus.DISBURSED) {
      api.transactions.getQR(transaction.id)
        .then(res => {
          setQrUrl(res.qrDataUrl);
        })
        .catch(err => {
          // Check if it's a connection error (backend not running)
          const isConnectionError = err.message?.includes('Backend server is not running') ||
                                   err.message?.includes('Failed to fetch') ||
                                   err.message?.includes('ERR_EMPTY_RESPONSE') ||
                                   err.isNetworkError;
          
          // Only log non-connection errors to avoid console spam
          if (!isConnectionError) {
            console.error('[QR_FETCH] Failed:', err);
          }
          
          // Only show fallback QR if error is not "already disbursed" and not a connection error
          if (!err.message?.includes('đã được giải ngân') && !isConnectionError) {
            // Fallback to simple QR if API fails (but backend is running)
            const qrData = `${transaction.id}|${transaction.compensation.totalApproved + (transaction.supplementaryAmount || 0)}|${transaction.household.name}`;
            setQrUrl(`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrData)}`);
          } else {
            // Clear QR for already disbursed transactions or when backend is not running
            setQrUrl('');
          }
        });
    } else {
      // Clear QR for already disbursed transactions
      setQrUrl('');
    }
  }, [transaction?.id, transaction?.status]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200 print:p-0 print:bg-white print:static">


      {/* --- WEB UI --- */}
      <GlassCard className="w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col relative bg-white/95 border-slate-300 shadow-2xl ring-1 ring-black/5 no-print">

        {/* Header */}
        <div className="flex justify-between items-start p-6 border-b border-slate-200 bg-slate-50/80 backdrop-blur-md">
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-slate-500 mb-1 uppercase tracking-wider">
              <FileText size={14} />
              <span>Phiếu chi thông tin khách hàng</span>
            </div>
            <h2 className="text-2xl font-bold text-slate-900">{transaction.household.name}</h2>
            <div className="flex items-center gap-2 mt-2">
              <StatusBadge status={transaction.status} />
              <span className="text-xs text-slate-500 font-medium ml-1">
                ID: {transaction.id}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-slate-200 text-slate-400 hover:text-slate-700 transition-colors"
          >
            <X size={24} />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex flex-col md:flex-row flex-1 overflow-hidden">

          {/* LEFT: Main Information */}
          <div className="flex-1 p-8 overflow-y-auto custom-scrollbar space-y-8 bg-white">

            {/* 1. Money Section */}
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                {/* Approved */}
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                  <p className="text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-1">Tổng phê duyệt</p>
                  <p className="text-lg font-bold text-slate-800">{formatCurrency(transaction.compensation.totalApproved)}</p>
                </div>
                {/* Interest */}
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                  <p className="text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-1">
                    Lãi phát sinh {hasRateChange ? '' : `(${interestRate}%)`}
                  </p>
                  <p className={`text-lg font-bold ${interest > 0 ? 'text-rose-600' : 'text-slate-400'}`}>
                    {interest > 0 ? '+' : ''}{formatCurrency(interest)}
                  </p>
                  {hasRateChange && (
                    <div className="mt-2 space-y-1 pt-2 border-t border-slate-200">
                      <div className="flex justify-between text-[10px] text-slate-600">
                        <span>Trước {interestRateChangeDate ? formatDate(interestRateChangeDate) : '01/01/2026'} ({interestRateBefore}%):</span>
                        <span className="font-bold text-rose-500">{formatCurrency(interestBefore)}</span>
                      </div>
                      <div className="flex justify-between text-[10px] text-slate-600">
                        <span>Từ {interestRateChangeDate ? formatDate(interestRateChangeDate) : '01/01/2026'} ({interestRateAfter}%):</span>
                        <span className="font-bold text-rose-500">{formatCurrency(interestAfter)}</span>
                      </div>
                    </div>
                  )}
                  <div className="text-[10px] text-slate-500 mt-1 font-medium flex items-center gap-1">
                    <Clock size={10} />
                    {isDisbursed
                      ? `Chốt đến ${formatDate(transaction.disbursementDate || '')}`
                      : (displayStartDate)
                        ? `Tính từ ${formatDate(displayStartDate.toISOString())}`
                        : 'Chưa bắt đầu tính lãi'
                    }
                  </div>
                </div>
              </div>

              {/* TOTAL BIG BOX - Professional Style */}
              <div className="p-6 rounded-2xl bg-slate-100 border border-slate-300 flex flex-col justify-center relative shadow-sm">
                <div className="absolute top-4 right-4 text-slate-300">
                  <Wallet size={48} strokeWidth={1.5} />
                </div>
                <p className="text-xs font-bold text-slate-600 uppercase tracking-widest mb-2">Tổng số tiền thực nhận</p>
                <p className="text-3xl font-bold text-slate-900 tracking-tight">{formatCurrency(totalAmount)}</p>
                <p className="text-[11px] text-slate-500 mt-2 font-medium italic">
                  = Tổng phê duyệt + Lãi phát sinh {supplementary !== 0 ? `${supplementary > 0 ? '+ Tiền bổ sung' : '+ Giảm bổ sung'}` : ''} {interest === 0 && supplementary === 0 && '(Chưa tính)'}
                </p>
              </div>

              {/* Box Tiền bổ sung */}
              <div className="p-4 rounded-xl bg-blue-50 border border-blue-300">
                <p className="text-[10px] font-bold text-blue-700 uppercase tracking-wider mb-2 flex items-center gap-1">
                  <Plus size={12} /> Số tiền bổ sung vào gốc
                </p>
                <div className="space-y-2">
                  <div className="flex items-center gap-2 mb-1">
                    <Calendar size={14} className="text-blue-700" />
                    <p className="text-xs font-bold text-blue-700">Chọn ngày bổ sung:</p>
                  </div>
                  <input
                    type="date"
                    value={supplementaryDateInput}
                    onChange={(e) => setSupplementaryDateInput(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-blue-300 rounded-lg text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <div>
                    <p className="text-xs font-bold text-blue-700 mb-1">Số tiền bổ sung:</p>
                    <input
                      type="text"
                      value={supplementaryAmountInput}
                      onChange={(e) => {
                        const value = e.target.value;
                        setSupplementaryAmountInput(value);
                        const parsed = parseNumberFromComma(value);
                        setSupplementaryAmount(parsed);
                      }}
                      onBlur={(e) => {
                        const parsed = parseNumberFromComma(e.target.value);
                        setSupplementaryAmountInput(formatNumberWithComma(parsed));
                      }}
                      className="w-full px-3 py-2 bg-white border border-blue-300 rounded-lg text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Nhập số tiền bổ sung (ví dụ: 1,000,000)"
                    />
                    <p className="text-[10px] text-blue-600 mt-1 italic">
                      * Số tiền này sẽ được cộng vào tổng phê duyệt và tính lãi từ ngày bổ sung
                    </p>
                  </div>
                  <textarea
                    value={supplementaryNote}
                    onChange={(e) => setSupplementaryNote(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-blue-300 rounded-lg text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Ghi chú..."
                    rows={2}
                  />
                  <button
                    onClick={handleSaveSupplementary}
                    disabled={isSavingSupplementary || parseNumberFromComma(supplementaryAmountInput) <= 0 || !supplementaryDateInput}
                    className="w-full py-2 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {isSavingSupplementary ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        Đang lưu...
                      </>
                    ) : (
                      <>
                        <Save size={14} />
                        Lưu tiền bổ sung
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Box Tiền còn lại sau khi rút (chỉ hiện khi đã rút một phần) */}
              {remainingAfterWithdraw !== undefined && remainingAfterWithdraw > 0 && (
                <div className="p-6 rounded-2xl bg-amber-50 border-2 border-amber-300 flex flex-col justify-center relative shadow-sm">
                  <div className="absolute top-4 right-4 text-amber-300">
                    <ArrowDownCircle size={48} strokeWidth={1.5} />
                  </div>
                  <p className="text-xs font-bold text-amber-700 uppercase tracking-widest mb-2">Tiền còn lại sau khi rút</p>
                  <p className="text-3xl font-bold text-amber-900 tracking-tight">{formatCurrency(remainingAfterWithdraw)}</p>
                  <p className="text-[11px] text-amber-600 mt-2 font-medium italic">
                    Lãi kép sẽ tiếp tục tính trên số tiền này
                  </p>
                </div>
              )}

              {/* Form Rút tiền (chỉ hiện khi chưa giải ngân hoàn toàn) */}
              {!isDisbursed && (
                <div className="p-4 rounded-xl bg-blue-50 border-2 border-blue-300">
                  {!showWithdrawForm ? (
                    <button
                      onClick={() => setShowWithdrawForm(true)}
                      className="w-full py-3 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 transition-all flex items-center justify-center gap-2"
                    >
                      <ArrowDownCircle size={18} />
                      Rút tiền
                    </button>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 mb-2">
                        <Calendar size={14} className="text-blue-700" />
                        <p className="text-xs font-bold text-blue-700">Chọn ngày rút:</p>
                      </div>
                      <input
                        type="date"
                        value={withdrawDateInput}
                        onChange={(e) => setWithdrawDateInput(e.target.value)}
                        className="w-full px-3 py-2 bg-white border-2 border-blue-300 rounded-lg text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <div>
                        <p className="text-xs font-bold text-blue-700 mb-1">Số tiền muốn rút:</p>
                        <input
                          type="text"
                          value={withdrawAmountInput}
                          onChange={(e) => {
                            const value = e.target.value;
                            setWithdrawAmountInput(value);
                          }}
                          onBlur={(e) => {
                            const parsed = parseNumberFromComma(e.target.value);
                            setWithdrawAmountInput(formatNumberWithComma(parsed));
                          }}
                          className="w-full px-3 py-2 bg-white border-2 border-blue-300 rounded-lg text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          placeholder="Nhập số tiền muốn rút"
                        />
                        <p className="text-[10px] text-blue-600 mt-1">
                          Có thể rút tối đa: {formatCurrency(totalAmount)}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={handleWithdraw}
                          disabled={isWithdrawing || !withdrawAmountInput}
                          className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 transition-all flex items-center justify-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {isWithdrawing ? (
                            <>
                              <Loader2 size={14} className="animate-spin" />
                              Đang rút...
                            </>
                          ) : (
                            <>
                              <CheckCircle size={14} />
                              Xác nhận rút
                            </>
                          )}
                        </button>
                        <button
                          onClick={() => {
                            setShowWithdrawForm(false);
                            setWithdrawAmountInput('');
                          }}
                          className="flex-1 py-2 bg-slate-200 text-slate-700 rounded-lg text-xs font-bold hover:bg-slate-300 transition-all"
                        >
                          Hủy
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 2. Details Grid */}
            <div>
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-xs font-bold text-slate-900 border-b border-slate-200 pb-2 uppercase tracking-wide flex-1">
                  Chi tiết hồ sơ
                </h3>
                {!isEditingDetails ? (
                  <button
                    onClick={() => setIsEditingDetails(true)}
                    className="ml-4 px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg text-xs font-bold hover:bg-slate-200 transition-all flex items-center gap-1 border border-slate-200"
                  >
                    <Edit2 size={12} />
                    Chỉnh sửa
                  </button>
                ) : (
                  <div className="ml-4 flex gap-2">
                    <button
                      onClick={() => {
                        setIsEditingDetails(false);
                        setEditedTransaction(transaction ? { ...transaction } : null);
                      }}
                      className="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg text-xs font-bold hover:bg-slate-200 transition-all border border-slate-200"
                    >
                      Hủy
                    </button>
                    <button
                      onClick={handleSaveDetails}
                      className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 transition-all flex items-center gap-1"
                    >
                      <Save size={12} />
                      Lưu
                    </button>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 bg-white rounded-xl border border-slate-200 shadow-sm hover:border-slate-300 transition-colors">
                  <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">Mã dự án</p>
                  {isEditingDetails && editedTransaction ? (
                    <input
                      type="text"
                      value={project?.code || editedTransaction.projectId}
                      onChange={(e) => setEditedTransaction({ ...editedTransaction, projectId: e.target.value })}
                      className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded text-sm font-bold text-slate-900 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  ) : (
                    <p className="text-sm font-bold text-slate-900 truncate" title={project?.code || transaction.projectId}>
                      {project?.code || transaction.projectId}
                    </p>
                  )}
                </div>
                <div className="p-3 bg-white rounded-xl border border-slate-200 shadow-sm hover:border-slate-300 transition-colors">
                  <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">Mã hộ dân</p>
                  {isEditingDetails && editedTransaction ? (
                    <input
                      type="text"
                      value={editedTransaction.household.id}
                      onChange={(e) => setEditedTransaction({
                        ...editedTransaction,
                        household: { ...editedTransaction.household, id: e.target.value }
                      })}
                      className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded text-sm font-mono font-bold text-slate-900 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  ) : (
                    <p className="text-sm font-bold text-slate-900 font-mono">{transaction.household.id}</p>
                  )}
                </div>
                <div className="p-3 bg-white rounded-xl border border-slate-200 shadow-sm hover:border-slate-300 transition-colors">
                  <p className="text-[10px] text-slate-500 uppercase font-bold mb-1 flex items-center gap-1">
                    <FileText size={10} /> Loại chi trả
                  </p>
                  {isEditingDetails && editedTransaction ? (
                    <input
                      type="text"
                      value={editedTransaction.paymentType || ''}
                      onChange={(e) => setEditedTransaction({ ...editedTransaction, paymentType: e.target.value })}
                      className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded text-sm font-bold text-slate-900 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      placeholder="Nhập loại chi trả"
                    />
                  ) : (
                    <p className="text-sm font-bold text-slate-900">{transaction.paymentType || '-'}</p>
                  )}
                </div>
                <div className="p-3 bg-white rounded-xl border border-slate-200 shadow-sm hover:border-slate-300 transition-colors">
                  <p className="text-[10px] text-slate-500 uppercase font-bold mb-1 flex items-center gap-1">
                    <Scale size={10} /> Số Quyết định
                  </p>
                  {isEditingDetails && editedTransaction ? (
                    <div className="space-y-1">
                      <input
                        type="text"
                        value={editedTransaction.household.decisionNumber}
                        onChange={(e) => setEditedTransaction({
                          ...editedTransaction,
                          household: { ...editedTransaction.household, decisionNumber: e.target.value }
                        })}
                        className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded text-sm font-bold text-slate-900 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      <input
                        type="date"
                        value={editedTransaction.household.decisionDate ? editedTransaction.household.decisionDate.split('T')[0] : ''}
                        onChange={(e) => setEditedTransaction({
                          ...editedTransaction,
                          household: { ...editedTransaction.household, decisionDate: e.target.value }
                        })}
                        className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded text-[10px] font-medium text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                  ) : (
                    <>
                      <p className="text-sm font-bold text-slate-900">{transaction.household.decisionNumber}</p>
                      <p className="text-[10px] text-slate-500 font-medium mt-0.5">
                        Ngày: {formatDate(transaction.household.decisionDate)}
                      </p>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* 3. History Section (Toggle) */}
            {showHistory && (
              <div className="animate-in slide-in-from-top-2 duration-300 pt-2">
                <h3 className="text-xs font-bold text-slate-900 border-b border-slate-200 pb-2 mb-4 uppercase tracking-wide flex items-center gap-2">
                  <History size={14} /> Lịch sử giao dịch
                </h3>
                <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 space-y-4 max-h-[200px] overflow-y-auto custom-scrollbar">
                  {transaction.history && transaction.history.length > 0 ? (
                    transaction.history.map((log, idx) => (
                      <div key={idx} className="relative pl-4 border-l-2 border-slate-300 pb-2 last:pb-0">
                        <div className="absolute -left-[5px] top-0 w-2.5 h-2.5 rounded-full bg-slate-600 ring-2 ring-white"></div>
                        <div className="flex justify-between items-start">
                          <span className="text-xs font-bold text-slate-800">{log.action}</span>
                          <span className="text-[10px] font-mono text-slate-500">{formatTz(toVNTime(log.timestamp), 'dd/MM/yyyy HH:mm:ss', { timeZone: VN_TIMEZONE })}</span>
                        </div>
                        <p className="text-[11px] text-slate-600 mt-1 leading-snug">{log.details}</p>
                        {log.totalAmount && (
                          <p className="text-xs font-bold text-emerald-600 mt-1">
                            {formatCurrency(log.totalAmount)}
                          </p>
                        )}
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-slate-400 italic text-center">Chưa có lịch sử giao dịch nào.</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* RIGHT: Actions */}
          <div className="w-full md:w-80 bg-slate-50 border-l border-slate-200 p-8 flex flex-col items-center justify-between">
            <div className="w-full text-center space-y-6">
              <div className="relative group mx-auto w-max" onClick={handlePrint}>
                <div className="w-48 h-48 bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex items-center justify-center relative overflow-hidden">
                  {/* Display Real QR Code if possible, otherwise use large icon */}
                  <img src={qrUrl} alt="Scan QR" className="w-full h-full object-contain" />
                </div>
                <div className="absolute inset-0 bg-blue-900/10 backdrop-blur-[1px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded-xl cursor-pointer shadow-inner border border-slate-200">
                  <div className="bg-white px-4 py-2 rounded-full shadow-lg flex items-center gap-2">
                    <Printer size={16} className="text-blue-600" />
                    <span className="text-xs font-bold text-blue-700 uppercase tracking-wide">In phiếu chi</span>
                  </div>
                </div>
              </div>

              <div>
                <p className="text-[10px] text-slate-400 uppercase tracking-widest mb-1">Mã tham chiếu hệ thống</p>
                <p className="text-xs font-mono font-bold text-slate-600 bg-slate-200/50 py-1.5 px-3 rounded-lg inline-block border border-slate-200">{transaction.id}</p>
              </div>
            </div>

            <div className="w-full space-y-3 mt-8">
              {!isDisbursed ? (
                <>
                  <button
                    onClick={handleConfirmPayment}
                    className="w-full py-3.5 bg-slate-900 text-white rounded-xl text-sm font-bold hover:bg-black transition-all shadow-lg hover:shadow-xl hover:-translate-y-0.5 flex items-center justify-center gap-2 group border border-transparent"
                  >
                    <Wallet size={18} className="text-blue-400 group-hover:text-blue-300 transition-colors" />
                    Xác nhận chi trả
                  </button>
                  
                  {/* New button: Xác nhận chi trả vào ngày */}
                  {showPaymentDatePicker ? (
                    <div className="space-y-2 p-4 bg-blue-50 border-2 border-blue-300 rounded-xl animate-in slide-in-from-top-2 duration-200">
                      <div className="flex items-center gap-2 mb-2">
                        <Calendar size={14} className="text-blue-700" />
                        <p className="text-xs font-bold text-blue-700">Chọn ngày chi trả:</p>
                      </div>
                      <input
                        type="date"
                        value={paymentDateInput}
                        onChange={(e) => setPaymentDateInput(e.target.value)}
                        className="w-full px-3 py-2 bg-white border-2 border-blue-300 rounded-lg text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                      {transaction.disbursementDate && (
                        <p className="text-[10px] text-blue-600 font-medium mt-1 flex items-center gap-1">
                          <Clock size={10} />
                          Ngày hiện tại: {formatDate(transaction.disbursementDate)}
                        </p>
                      )}
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={handleConfirmPaymentDate}
                          disabled={isSavingPaymentDate || !paymentDateInput}
                          className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 transition-all flex items-center justify-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {isSavingPaymentDate ? (
                            <>
                              <Loader2 size={14} className="animate-spin" />
                              Đang lưu...
                            </>
                          ) : (
                            <>
                              <CheckCircle size={14} />
                              Xác nhận
                            </>
                          )}
                        </button>
                        <button
                          onClick={() => {
                            setShowPaymentDatePicker(false);
                            // Reset to current transaction date or today in VN timezone
                            if (transaction.disbursementDate) {
                              const vnDate = toVNTime(transaction.disbursementDate);
                              const year = vnDate.getFullYear();
                              const month = String(vnDate.getMonth() + 1).padStart(2, '0');
                              const day = String(vnDate.getDate()).padStart(2, '0');
                              setPaymentDateInput(`${year}-${month}-${day}`);
                            } else {
                              const todayVN = toVNTime(new Date());
                              const year = todayVN.getFullYear();
                              const month = String(todayVN.getMonth() + 1).padStart(2, '0');
                              const day = String(todayVN.getDate()).padStart(2, '0');
                              setPaymentDateInput(`${year}-${month}-${day}`);
                            }
                          }}
                          className="flex-1 py-2 bg-slate-200 text-slate-700 rounded-lg text-xs font-bold hover:bg-slate-300 transition-all"
                        >
                          Hủy
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowPaymentDatePicker(true)}
                      className="w-full py-2.5 bg-blue-50 text-blue-700 rounded-xl text-xs font-bold hover:bg-blue-100 transition-all border border-blue-200 shadow-sm flex items-center justify-center gap-2"
                    >
                      <Calendar size={14} />
                      {transaction.disbursementDate 
                        ? `Ngày chi trả: ${formatDate(transaction.disbursementDate)}` 
                        : 'Xác nhận chi trả vào ngày'}
                    </button>
                  )}
                </>
              ) : (
                <>
                  {localStatus === TransactionStatus.DISBURSED ? (
                    <>
                      <button disabled className="w-full py-3.5 bg-emerald-600 text-white rounded-xl text-sm font-bold flex items-center justify-center gap-2 cursor-default opacity-90 shadow-sm border border-emerald-700">
                        <CheckCircle size={18} />
                        Đã giải ngân
                      </button>
                      {transaction.disbursementDate && (
                        <div className="p-2 bg-emerald-50 border border-emerald-200 rounded-lg">
                          <p className="text-[10px] text-emerald-700 font-medium text-center">
                            Ngày chi trả: {formatDate(transaction.disbursementDate)}
                          </p>
                        </div>
                      )}
                      {/* Nút nạp tiền chỉ hiện khi đang ở trạng thái đã giải ngân */}
                      {!showRefundForm ? (
                        <button
                          onClick={() => {
                            // Set default amount to totalAmount
                            setRefundAmountInput(formatNumberWithComma(Math.round(totalAmount)));
                            setShowRefundForm(true);
                          }}
                          className="w-full py-2.5 bg-amber-50 text-amber-700 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-amber-100 transition-all border border-amber-200 shadow-sm"
                        >
                          <Undo2 size={14} />
                          Nạp tiền / Hoàn quỹ
                        </button>
                      ) : (
                        <div className="space-y-3 p-4 bg-amber-50 border-2 border-amber-300 rounded-xl animate-in slide-in-from-top-2 duration-200">
                          <div className="flex items-center gap-2 mb-2">
                            <Calendar size={14} className="text-amber-700" />
                            <p className="text-xs font-bold text-amber-700">Chọn ngày nạp:</p>
                          </div>
                          <input
                            type="date"
                            value={refundDateInput}
                            onChange={(e) => setRefundDateInput(e.target.value)}
                            className="w-full px-3 py-2 bg-white border-2 border-amber-300 rounded-lg text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                          />
                          <div>
                            <p className="text-xs font-bold text-amber-700 mb-1">Số tiền muốn nạp:</p>
                            <input
                              type="text"
                              value={refundAmountInput}
                              onChange={(e) => {
                                const value = e.target.value;
                                setRefundAmountInput(value);
                              }}
                              onBlur={(e) => {
                                const parsed = parseNumberFromComma(e.target.value);
                                setRefundAmountInput(formatNumberWithComma(parsed));
                              }}
                              className="w-full px-3 py-2 bg-white border-2 border-amber-300 rounded-lg text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                              placeholder="Nhập số tiền muốn nạp"
                            />
                            <p className="text-[10px] text-amber-600 mt-1">
                              Có thể nạp tối đa: {formatCurrency(totalAmount)}
                            </p>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={handleRefundMoney}
                              disabled={isRefunding || !refundAmountInput || !refundDateInput}
                              className="flex-1 py-2 bg-amber-600 text-white rounded-lg text-xs font-bold hover:bg-amber-700 transition-all flex items-center justify-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {isRefunding ? (
                                <>
                                  <Loader2 size={14} className="animate-spin" />
                                  Đang nạp...
                                </>
                              ) : (
                                <>
                                  <CheckCircle size={14} />
                                  Xác nhận nạp
                                </>
                              )}
                            </button>
                            <button
                              onClick={() => {
                                setShowRefundForm(false);
                                setRefundAmountInput('');
                              }}
                              className="flex-1 py-2 bg-slate-200 text-slate-700 rounded-lg text-xs font-bold hover:bg-slate-300 transition-all"
                            >
                              Hủy
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    // Sau khi nạp tiền, trạng thái sẽ là HOLD và nút nạp tiền/hoàn quỹ biến mất, hiển thị nút xác nhận lại
                    <button
                      onClick={handleConfirmPayment}
                      className="w-full py-3.5 bg-blue-600 text-white rounded-xl text-sm font-bold flex items-center justify-center gap-2 shadow-sm border border-blue-700"
                    >
                      <CheckCircle size={18} />
                      Xác nhận giải ngân
                    </button>
                  )}
                </>
              )}

              <button
                onClick={() => setShowHistory(!showHistory)}
                className={`w-full py-3.5 border rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 ${showHistory
                  ? 'bg-white border-slate-300 text-slate-900 shadow-sm'
                  : 'bg-transparent border-slate-300 text-slate-600 hover:bg-white hover:shadow-sm'
                  }`}
              >
                <History size={16} />
                {showHistory ? 'Ẩn lịch sử' : 'Xem lịch sử'}
              </button>
            </div>
          </div>

        </div>
      </GlassCard>

      {showPrintPreview && (
        <PrintPhieuChi
          interestRateChangeDate={interestRateChangeDate}
          interestRateBefore={interestRateBefore}
          interestRateAfter={interestRateAfter}
          transaction={transaction}
          project={project}
          interestRate={interestRate}
          currentUser={currentUser}
          onTransactionUpdated={onUpdateTransaction}
          onClose={() => setShowPrintPreview(false)}
        />
      )}
    </div>
  );
};
