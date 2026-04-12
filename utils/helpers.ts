
import { Transaction, Project, TransactionStatus, AuditLogItem } from '../types';
// Import date-fns-tz functions (v3 uses toZonedTime and fromZonedTime)
import { toZonedTime, fromZonedTime, format as formatTz } from 'date-fns-tz';

// Timezone constant for Vietnam
export const VN_TIMEZONE = 'Asia/Ho_Chi_Minh';

// Helper: Get current date/time in VN timezone
export const getVNNow = (): Date => {
  return toZonedTime(new Date(), VN_TIMEZONE);
};

// Helper: Convert date to VN timezone
export const toVNTime = (date: Date | string): Date => {
  const d = typeof date === 'string' ? new Date(date) : date;
  return toZonedTime(d, VN_TIMEZONE);
};

// Helper: Convert VN timezone date to UTC for storage
export const fromVNTime = (date: Date | string): Date => {
  const d = typeof date === 'string' ? new Date(date) : date;
  return fromZonedTime(d, VN_TIMEZONE);
};

// Helper: Get start of day in VN timezone
export const getVNStartOfDay = (date?: Date | string): Date => {
  const d = date ? (typeof date === 'string' ? new Date(date) : date) : getVNNow();
  const vnDate = toVNTime(d);
  vnDate.setHours(0, 0, 0, 0);
  return vnDate;
};

// Helper: Get end of day in VN timezone
export const getVNEndOfDay = (date?: Date | string): Date => {
  const d = date ? (typeof date === 'string' ? new Date(date) : date) : getVNNow();
  const vnDate = toVNTime(d);
  vnDate.setHours(23, 59, 59, 999);
  return vnDate;
};

// Chuẩn hóa làm tròn: giữ 2 chữ số thập phân, .49 trở xuống làm tròn xuống, .50 trở lên làm tròn lên
export const roundTo2 = (value: number): number => {
  if (!isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
};

export const formatCurrency = (amount: number): string => {
  const rounded = roundTo2(amount);
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(rounded);
};

// Format number with comma separator (for input display)
export const formatNumberWithComma = (value: number | string): string => {
  if (value === '' || value === null || value === undefined) return '';
  const num = typeof value === 'string' ? parseFloat(value.replace(/,/g, '')) : value;
  if (isNaN(num)) return '';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

// Parse number from string with comma separator
export const parseNumberFromComma = (value: string): number => {
  if (!value) return 0;
  const cleaned = value.replace(/,/g, '').trim();
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
};

/**
 * Tính lãi theo cách của ngân hàng: lãi nhập gốc theo từng kỳ (tháng)
 * Mỗi kỳ tính lãi dựa trên số dư đầu kỳ, sau đó cộng lãi vào gốc để tính kỳ tiếp theo
 * 
 * Ví dụ từ phiếu ngân hàng:
 * - Kỳ 1 (21/08-01/09): Số dư 97,923,200 → Lãi 2,951 → Số dư mới 97,926,151
 * - Kỳ 2 (01/09-01/10): Số dư 97,926,151 → Lãi 8,049 → Số dư mới 97,934,200
 * - Kỳ 3 (01/10-01/11): Số dư 97,934,200 → Lãi 8,318 → Số dư mới 97,942,518
 */
export const calculateInterest = (principal: number, ratePerYear: number, baseDateStr?: any, endDate: Date = getVNNow()): number => {
  if (!baseDateStr) return 0;

  // Handle different date input types
  let baseDate: Date;
  if (baseDateStr instanceof Date) {
    baseDate = new Date(baseDateStr);
  } else if (typeof baseDateStr === 'object') {
    // Invalid object, return 0
    return 0;
  } else {
    baseDate = new Date(baseDateStr);
  }

  // Validate baseDate
  if (isNaN(baseDate.getTime())) return 0;

  // Convert to VN timezone and reset to start of day (00:00:00 VN time)
  const baseDateVN = getVNStartOfDay(baseDate);
  const endDateVN = getVNStartOfDay(endDate);

  const timeDiff = endDateVN.getTime() - baseDateVN.getTime();
  const totalDays = Math.floor(timeDiff / (1000 * 3600 * 24));

  // Nếu chưa qua mốc 00:00 nào sau baseDate thì chưa có lãi
  if (totalDays <= 0) return 0;

  // Tính lãi theo cách ngân hàng: lãi nhập gốc theo từng kỳ (tháng)
  let currentBalance = principal;
  let totalInterest = 0;
  let currentDate = new Date(baseDateVN);

  // Daily rate
  const dailyRate = (ratePerYear / 100) / 365;

  // Tính lãi theo từng kỳ (tháng)
  while (currentDate < endDateVN) {
    // Xác định ngày kết thúc kỳ (ngày đầu tháng tiếp theo)
    // Đảm bảo tính trong VN timezone
    const periodEnd = new Date(currentDate);
    periodEnd.setMonth(periodEnd.getMonth() + 1);
    periodEnd.setDate(1); // Ngày đầu tháng tiếp theo
    // Convert to VN timezone để đảm bảo nhất quán
    const periodEndVN = getVNStartOfDay(periodEnd);

    // Nếu periodEnd vượt quá endDate, dùng endDate
    const actualPeriodEnd = periodEndVN > endDateVN ? endDateVN : periodEndVN;

    // Số ngày trong kỳ này
    const daysInPeriod = Math.floor(
      (actualPeriodEnd.getTime() - currentDate.getTime()) / (1000 * 3600 * 24)
    );

    if (daysInPeriod > 0) {
      // Tính lãi cho kỳ này dựa trên số dư hiện tại (đã bao gồm lãi từ các kỳ trước)
      // Giữ 2 chữ số thập phân trong quá trình tính toán, tránh làm tròn nguyên từng kỳ
      const rawPeriodInterest = currentBalance * dailyRate * daysInPeriod;
      const periodInterest = Math.round(rawPeriodInterest * 100) / 100;
      totalInterest += periodInterest;
      
      // Cộng lãi vào gốc để tính kỳ tiếp theo (lãi nhập gốc)
      currentBalance += periodInterest;
    }

    // Chuyển sang kỳ tiếp theo
    currentDate = new Date(actualPeriodEnd);
  }

  return totalInterest;
};

/**
 * Tính lãi với mốc thay đổi lãi suất (ví dụ: 01/01/2026)
 * Tính liên tục theo từng kỳ tháng, áp dụng lãi suất phù hợp cho từng kỳ
 * @param principal - Số tiền gốc ban đầu
 * @param baseDateStr - Ngày bắt đầu tính lãi
 * @param endDate - Ngày kết thúc tính lãi
 * @param rateChangeDateStr - Ngày thay đổi lãi suất (ví dụ: 01/01/2026)
 * @param rateBefore - Lãi suất trước mốc (%)
 * @param rateAfter - Lãi suất sau mốc (%)
 * @returns Tổng lãi và chi tiết 2 giai đoạn
 */
export const calculateInterestWithRateChange = (
    principal: number,
    baseDateStr: any,
    endDate: Date = getVNNow(),
    rateChangeDateStr: string | Date,
    rateBefore: number,
    rateAfter: number
): { 
    totalInterest: number; 
    interestBefore: number; 
    interestAfter: number;
    balanceAtChange: number; // Số dư tại mốc thay đổi (gốc + lãi trước mốc)
} => {
    if (!baseDateStr) {
        return {
            totalInterest: 0,
            interestBefore: 0,
            interestAfter: 0,
            balanceAtChange: principal
        };
    }

    // Handle different date input types
    let baseDate: Date;
    if (baseDateStr instanceof Date) {
        baseDate = new Date(baseDateStr);
    } else if (typeof baseDateStr === 'object') {
        return {
            totalInterest: 0,
            interestBefore: 0,
            interestAfter: 0,
            balanceAtChange: principal
        };
    } else {
        baseDate = new Date(baseDateStr);
    }

    // Validate baseDate
    if (isNaN(baseDate.getTime())) {
        return {
            totalInterest: 0,
            interestBefore: 0,
            interestAfter: 0,
            balanceAtChange: principal
        };
    }

    const baseDateVN = getVNStartOfDay(baseDate);
    const endDateVN = getVNStartOfDay(endDate);
    const changeDateVN = getVNStartOfDay(rateChangeDateStr);

    // Nếu endDate trước mốc thay đổi, chỉ tính với rateBefore
    if (endDateVN <= changeDateVN) {
        const interest = calculateInterest(principal, rateBefore, baseDateVN, endDateVN);
        return {
            totalInterest: interest,
            interestBefore: interest,
            interestAfter: 0,
            balanceAtChange: principal + interest
        };
    }

    // Nếu baseDate sau mốc thay đổi, chỉ tính với rateAfter
    if (baseDateVN >= changeDateVN) {
        const interest = calculateInterest(principal, rateAfter, baseDateVN, endDateVN);
        return {
            totalInterest: interest,
            interestBefore: 0,
            interestAfter: interest,
            balanceAtChange: principal
        };
    }

    // Tính lãi liên tục theo từng kỳ tháng, áp dụng lãi suất phù hợp cho từng kỳ
    // Logic: Lãi nhập gốc theo từng kỳ tháng (từ đầu tháng đến đầu tháng tiếp theo)
    let currentBalance = principal;
    let totalInterest = 0;
    let interestBefore = 0;
    let interestAfter = 0;
    let currentDate = new Date(baseDateVN);
    let balanceAtChange = principal;

    while (currentDate < endDateVN) {
        // Xác định ngày kết thúc kỳ (ngày đầu tháng tiếp theo)
        const periodEnd = new Date(currentDate);
        periodEnd.setMonth(periodEnd.getMonth() + 1);
        periodEnd.setDate(1);
        const periodEndVN = getVNStartOfDay(periodEnd);

        // Nếu periodEnd vượt quá endDate, dùng endDate
        const actualPeriodEnd = periodEndVN > endDateVN ? endDateVN : periodEndVN;
        
        // Xác định lãi suất cho kỳ này
        // Nếu kỳ bắt đầu từ trước mốc thay đổi và kết thúc sau mốc, cần chia kỳ
        const periodStartsBeforeChange = currentDate < changeDateVN;
        const periodEndsAfterChange = actualPeriodEnd > changeDateVN;
        const changeDateIsInPeriod = periodStartsBeforeChange && periodEndsAfterChange;
        
        if (changeDateIsInPeriod) {
            // Kỳ này chứa mốc thay đổi: chia thành 2 phần
            // Phần 1: Từ currentDate đến changeDate (dùng rateBefore)
            const daysBeforeChange = Math.floor(
                (changeDateVN.getTime() - currentDate.getTime()) / (1000 * 3600 * 24)
            );
            if (daysBeforeChange > 0) {
                const dailyRateBefore = (rateBefore / 100) / 365;
                const rawInterestBefore = currentBalance * dailyRateBefore * daysBeforeChange;
                const periodInterestBefore = Math.round(rawInterestBefore * 100) / 100;
                interestBefore += periodInterestBefore;
                totalInterest += periodInterestBefore;
                currentBalance += periodInterestBefore;
                balanceAtChange = currentBalance; // Lưu số dư tại mốc thay đổi
            }
            
            // Phần 2: Từ changeDate đến actualPeriodEnd (dùng rateAfter)
            const daysAfterChange = Math.floor(
                (actualPeriodEnd.getTime() - changeDateVN.getTime()) / (1000 * 3600 * 24)
            );
            if (daysAfterChange > 0) {
                const dailyRateAfter = (rateAfter / 100) / 365;
                const rawInterestAfter = currentBalance * dailyRateAfter * daysAfterChange;
                const periodInterestAfter = Math.round(rawInterestAfter * 100) / 100;
                interestAfter += periodInterestAfter;
                totalInterest += periodInterestAfter;
                currentBalance += periodInterestAfter;
            }
        } else {
            // Kỳ bình thường: dùng rateBefore hoặc rateAfter
            const daysInPeriod = Math.floor(
                (actualPeriodEnd.getTime() - currentDate.getTime()) / (1000 * 3600 * 24)
            );
            
            if (daysInPeriod > 0) {
                // Xác định lãi suất: nếu kỳ bắt đầu từ mốc thay đổi trở đi, dùng rateAfter
                const useRateAfter = currentDate >= changeDateVN;
                const currentRate = useRateAfter ? rateAfter : rateBefore;
                const dailyRate = (currentRate / 100) / 365;
                const rawPeriodInterest = currentBalance * dailyRate * daysInPeriod;
                const periodInterest = Math.round(rawPeriodInterest * 100) / 100;
                
                if (useRateAfter) {
                    interestAfter += periodInterest;
                } else {
                    interestBefore += periodInterest;
                }
                
                totalInterest += periodInterest;
                currentBalance += periodInterest;
                
                // Lưu số dư tại mốc thay đổi nếu kỳ này kết thúc đúng tại mốc
                if (!useRateAfter && actualPeriodEnd.getTime() === changeDateVN.getTime()) {
                    balanceAtChange = currentBalance;
                }
            }
        }

        // Chuyển sang kỳ tiếp theo
        currentDate = new Date(actualPeriodEnd);
    }

    return {
        totalInterest,
        interestBefore,
        interestAfter,
        balanceAtChange
    };
};

export const formatDate = (dateString: string): string => {
  if (!dateString) return '';
  const date = toVNTime(dateString);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
};

// Format date to dd/mm/yyyy (used for display only)
export const formatDateDisplay = (dateString?: string): string => {
  if (!dateString) return '---';
  const d = toVNTime(dateString);
  if (isNaN(d.getTime())) return dateString;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
};

// Format date for print receipt: "Ngày 01 tháng 01 năm 2025"
export const formatDateForPrint = (dateString: string): string => {
  if (!dateString) return '';
  const date = toVNTime(dateString);
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  return `Ngày ${day} tháng ${month} năm ${year}`;
};

// Convert number to Vietnamese words (supports amounts ≥ 1 tỷ by splitting the tỷ part)
export const numberToVietnameseWords = (num: number): string => {
  // Handle invalid inputs
  if (num === null || num === undefined || isNaN(num) || !isFinite(num)) {
    return 'không';
  }

  // Round to nearest integer for word conversion
  const roundedNum = Math.round(num);
  if (roundedNum === 0) return 'không';

  const ones = ['', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
  const tens = ['', '', 'hai mươi', 'ba mươi', 'bốn mươi', 'năm mươi', 'sáu mươi', 'bảy mươi', 'tám mươi', 'chín mươi'];
  const hundreds = ['', 'một trăm', 'hai trăm', 'ba trăm', 'bốn trăm', 'năm trăm', 'sáu trăm', 'bảy trăm', 'tám trăm', 'chín trăm'];

  const readGroup = (n: number): string => {
    if (n === 0) return '';

    let result = '';
    const hundred = Math.floor(n / 100);
    const remainder = n % 100;
    const ten = Math.floor(remainder / 10);
    const one = remainder % 10;

    if (hundred > 0) {
      result += hundreds[hundred] + ' ';
    }

    if (ten > 1) {
      result += tens[ten] + ' ';
      if (one > 0) {
        if (one === 5) {
          result += 'lăm';
        } else if (one === 1 && ten > 1) {
          result += 'mốt';
        } else {
          result += ones[one];
        }
      }
    } else if (ten === 1) {
      result += one === 0 ? 'mười' : `mười ${one === 5 ? 'lăm' : ones[one]}`;
    } else if (one > 0) {
      result += ones[one];
    }

    return result.trim();
  };

  /** Read 0 < n < 1_000_000_000 (triệu / nghìn / đơn vị only — used under one tỷ and for the tỷ coefficient). */
  const readUnderOneBillion = (numToProcess: number): string => {
    if (numToProcess < 1000) {
      return readGroup(numToProcess);
    }

    const millions = Math.floor(numToProcess / 1000000);
    const thousands = Math.floor((numToProcess % 1000000) / 1000);
    const remainder = numToProcess % 1000;

    let result = '';

    if (millions > 0) {
      result += readGroup(millions) + ' triệu ';
    }

    if (thousands > 0) {
      if (thousands < 10 && millions > 0) {
        result += 'không trăm ';
      }
      result += readGroup(thousands) + ' nghìn ';
    } else if (millions > 0 && remainder > 0) {
      result += 'không nghìn ';
    }

    if (remainder > 0) {
      if (remainder < 100 && (millions > 0 || thousands > 0)) {
        result += 'không trăm ';
      }
      result += readGroup(remainder);
    }

    return result.trim();
  };

  if (roundedNum < 1_000_000_000) {
    return readUnderOneBillion(roundedNum);
  }

  const billions = Math.floor(roundedNum / 1_000_000_000);
  const afterBillion = roundedNum % 1_000_000_000;
  let out = readUnderOneBillion(billions) + ' tỷ';
  if (afterBillion > 0) {
    out += ' ' + readUnderOneBillion(afterBillion);
  }
  return out.trim();
};

// Format currency amount to Vietnamese words
export const formatCurrencyToWords = (amount: number): string => {
  // Handle invalid inputs
  if (amount === null || amount === undefined || isNaN(amount) || !isFinite(amount)) {
    return 'Không đồng';
  }
  
  const words = numberToVietnameseWords(amount);
  // Ensure words is not empty
  if (!words || words.trim() === '') {
    return 'Không đồng';
  }
  
  const capitalized = words.charAt(0).toUpperCase() + words.slice(1);
  return `${capitalized} đồng`;
};

// --- EXPORT FUNCTIONS ---

const downloadCSV = (content: string, fileName: string) => {
  // Add BOM (Byte Order Mark) for UTF-8 so Excel opens it correctly with Vietnamese characters
  const bom = '\uFEFF';
  const blob = new Blob([bom + content], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);

  link.setAttribute('href', url);
  link.setAttribute('download', fileName);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

const downloadExcel = async (data: any[][], fileName: string) => {
  // Dynamic import to avoid build issues with xlsx
  const XLSX = await import('xlsx');
  
  // Create workbook and worksheet
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  
  // Set column widths (optional, for better formatting)
  const maxCols = Math.max(...data.map(row => row.length));
  const colWidths = [];
  for (let i = 0; i < maxCols; i++) {
    colWidths.push({ wch: 15 }); // Default width
  }
  ws['!cols'] = colWidths;
  
  // Add worksheet to workbook
  XLSX.utils.book_append_sheet(wb, ws, 'Báo cáo');
  
  // Write file
  XLSX.writeFile(wb, fileName);
};

export const exportTransactionsToExcel = (
  transactions: Transaction[], 
  projects: Project[], 
  interestRate: number,
  interestRateChangeDate?: string | null,
  interestRateBefore?: number | null,
  interestRateAfter?: number | null,
  filterEndDate?: string | null  // Point-in-Time filter date
) => {
  // Point-in-Time helper: Determine effective status at filter time
  const getEffectiveStatus = (t: Transaction): TransactionStatus => {
    // If no end date filter, return actual status
    if (!filterEndDate) return t.status;
    
    // If transaction has disbursementDate and it's AFTER the filter end date,
    // treat it as NOT disbursed (point-in-time view)
    if (t.disbursementDate) {
      const disbursementDateTime = new Date(t.disbursementDate).getTime();
      const filterEndTime = new Date(filterEndDate).setHours(23, 59, 59, 999);
      
      if (disbursementDateTime > filterEndTime) {
        // At filter time, this transaction was not yet disbursed
        return TransactionStatus.PENDING;
      }
    }
    
    // Otherwise return actual status
    return t.status;
  };

  const getEffectiveCalculationDate = (t: Transaction): Date => {
    // If no end date filter, use current logic
    if (!filterEndDate) {
      if (t.status === TransactionStatus.DISBURSED && t.disbursementDate) {
        return new Date(t.disbursementDate);
      }
      return new Date(); // Current date for pending
    }
    
    // With filter: check if transaction was disbursed at filter time
    const effectiveStatus = getEffectiveStatus(t);
    
    if (effectiveStatus === TransactionStatus.DISBURSED && t.disbursementDate) {
      // Was disbursed before filter date, use disbursementDate
      return new Date(t.disbursementDate);
    } else {
      // Was not disbursed at filter time, use filter end date
      const filterEnd = new Date(filterEndDate);
      filterEnd.setHours(23, 59, 59, 999);
      return filterEnd;
    }
  };

  // 1. Calculate Stats for ALL transactions (Total) - Use effective status
  const uniqueProjects = new Set(transactions.map(t => t.projectId)).size;
  const disbursedItems = transactions.filter(t => getEffectiveStatus(t) === TransactionStatus.DISBURSED);
  const notDisbursedItems = transactions.filter(t => getEffectiveStatus(t) !== TransactionStatus.DISBURSED);

  // Calculate money disbursed (matching TransactionList logic)
  const hasRateChange = interestRateChangeDate && interestRateBefore !== null && interestRateAfter !== null;
  
  // 1. Tiền đã giải ngân hoàn toàn (DISBURSED at filter time)
  const moneyDisbursedRawFromDisbursed = disbursedItems.reduce((sum, t) => {
    const pIdStr = (t.projectId && (t.projectId as any)._id) ? (t.projectId as any)._id.toString() : t.projectId?.toString();
    const project = projects.find(p => (p.id === pIdStr || p._id === pIdStr));
    const baseDate = t.effectiveInterestDate || project?.interestStartDate || (project as any)?.startDate;
    const principalBase = (t as any).principalForInterest ?? t.compensation.totalApproved;
    
    // Use effective calculation date (respects filter date)
    const calcDate = getEffectiveCalculationDate(t);
    
    let interest = 0;
    if (hasRateChange) {
      const interestResult = calculateInterestWithRateChange(
        principalBase,
        baseDate,
        calcDate,
        interestRateChangeDate,
        interestRateBefore,
        interestRateAfter
      );
      interest = interestResult.totalInterest;
    } else {
      interest = calculateInterest(principalBase, interestRate, baseDate, calcDate);
    }
    
    const supplementary = t.supplementaryAmount || 0;
    return sum + principalBase + interest + supplementary;
  }, 0);

  // 2. Tiền đã rút một phần từ các giao dịch chưa giải ngân hoàn toàn
  const moneyDisbursedRawFromPartial = notDisbursedItems
    .filter(t => (t as any).withdrawnAmount && (t as any).withdrawnAmount > 0)
    .reduce((sum, t) => sum + ((t as any).withdrawnAmount || 0), 0);

  const moneyDisbursed = moneyDisbursedRawFromDisbursed + moneyDisbursedRawFromPartial;

  // 3. Tiền chưa giải ngân (matching TransactionList logic)
  const moneyNotDisbursed = notDisbursedItems.reduce((sum, t) => {
    const pIdStr = (t.projectId && (t.projectId as any)._id) ? (t.projectId as any)._id.toString() : t.projectId?.toString();
    const project = projects.find(p => (p.id === pIdStr || p._id === pIdStr));
    const baseDate = t.effectiveInterestDate || project?.interestStartDate || (project as any)?.startDate;
    // Use principalForInterest for partially withdrawn transactions
    const principalBase = (t as any).principalForInterest ?? t.compensation.totalApproved;
    
    // Use effective calculation date (respects filter date)
    const calcDate = getEffectiveCalculationDate(t);
    
    let interest = 0;
    if (hasRateChange) {
      const interestResult = calculateInterestWithRateChange(
        principalBase,
        baseDate,
        calcDate,
        interestRateChangeDate,
        interestRateBefore,
        interestRateAfter
      );
      interest = interestResult.totalInterest;
    } else {
      interest = calculateInterest(principalBase, interestRate, baseDate, calcDate);
    }
    
    const supplementary = t.supplementaryAmount || 0;
    return sum + principalBase + interest + supplementary;
  }, 0);

  // Tổng lãi PS = chỉ tính lãi từ các giao dịch CHƯA giải ngân (giống tempInterest trong bảng)
  let tempInterest = 0; // Lãi tạm tính (chưa giải ngân)
  let lockedInterest = 0; // Lãi đã chốt (đã giải ngân)

  transactions.forEach(t => {
    const pIdStr = (t.projectId && (t.projectId as any)._id) ? (t.projectId as any)._id.toString() : t.projectId?.toString();
    const project = projects.find(p => (p.id === pIdStr || p._id === pIdStr));
    const baseDate = t.effectiveInterestDate || project?.interestStartDate || (project as any)?.startDate;
    // Nếu đã rút một phần, dùng principalForInterest làm gốc tính lãi (phần còn lại)
    const principalBase = (t as any).principalForInterest ?? t.compensation.totalApproved;
    
    // Use effective status at filter time
    const effectiveStatus = getEffectiveStatus(t);
    const calcDate = getEffectiveCalculationDate(t);

    if (effectiveStatus === TransactionStatus.DISBURSED) {
      // Lãi đã chốt (tại thời điểm filter)
      let interestForTransaction = 0;
      if (hasRateChange) {
        const interestResult = calculateInterestWithRateChange(
          principalBase,
          baseDate,
          calcDate,
          interestRateChangeDate,
          interestRateBefore,
          interestRateAfter
        );
        interestForTransaction = interestResult.totalInterest;
      } else {
        interestForTransaction = calculateInterest(principalBase, interestRate, baseDate, calcDate);
      }
      lockedInterest += interestForTransaction;
    } else {
      // Lãi tạm tính (chưa giải ngân tại thời điểm filter)
      let interestForTransaction = 0;
      if (hasRateChange) {
        const interestResult = calculateInterestWithRateChange(
          principalBase,
          baseDate,
          calcDate,
          interestRateChangeDate,
          interestRateBefore,
          interestRateAfter
        );
        interestForTransaction = interestResult.totalInterest;
      } else {
        interestForTransaction = calculateInterest(principalBase, interestRate, baseDate, calcDate);
      }
      tempInterest += interestForTransaction;
    }
  });

  const totalInterest = tempInterest; // Chỉ trả về lãi tạm tính

  // 2. Build CSV Content
  const rows = [];

  // --- Part A: Statistics Header (The 6 Boxes) ---
  rows.push(['BÁO CÁO TỔNG HỢP GIAO DỊCH', `Ngày xuất: ${formatTz(getVNNow(), 'dd/MM/yyyy', { timeZone: VN_TIMEZONE })}`]);
  rows.push([]); // Empty row
  rows.push(['THỐNG KÊ TỔNG QUAN']);
  rows.push(['Tổng dự án', 'Hộ đã GN', 'Hộ chưa GN', 'Tiền đã GN (Gốc+Lãi)', 'Tiền chưa GN (Gốc+Lãi)', 'Tổng lãi PS']);
  rows.push([
    Number(uniqueProjects) || 0,
    Number(disbursedItems.length) || 0,
    Number(notDisbursedItems.length) || 0,
    Number(moneyDisbursed) || 0,
    Number(moneyNotDisbursed) || 0,
    Number(totalInterest) || 0
  ]);
  rows.push([]); // Empty row
  rows.push([]); // Empty row

  // --- Part B: Details Table ---
  rows.push(['DANH SÁCH CHI TIẾT']);
  rows.push([
    'STT',
    'Mã GD',
    'Mã Hộ Dân',
    'Mã Dự Án',
    'Họ và tên',
    'Loại chi trả',
    'Số quyết định',
    'Ngày GN',
    'Tổng phê duyệt',
    'Lãi phát sinh',
    'Tiền bổ sung',
    'Đã rút',
    'Tổng chi trả',
    'Tiền còn lại',
    'Trạng thái'
  ]);

  transactions.forEach((t, index) => {
    const project = projects.find(p => p.id === t.projectId);

    // Calculate individual interest - KHỚP HOÀN TOÀN với logic trong bảng (Point-in-Time)
    const pIdStr = (t.projectId && (t.projectId as any)._id) ? (t.projectId as any)._id.toString() : t.projectId?.toString();
    const projectForInterest = projects.find(p => (p.id === pIdStr || p._id === pIdStr));
    // Nếu đã rút một phần, dùng principalForInterest làm gốc tính lãi (để tính lãi kép trên phần còn lại)
    const principalBase = (t as any).principalForInterest ?? t.compensation.totalApproved;
    const baseDate = t.effectiveInterestDate || projectForInterest?.interestStartDate || (projectForInterest as any)?.startDate;
    
    // Use effective status and calculation date (respects filter date)
    const effectiveStatus = getEffectiveStatus(t);
    const calcDate = getEffectiveCalculationDate(t);
    const isDisbursed = effectiveStatus === TransactionStatus.DISBURSED;
    
    let currentInterest = 0;

    // Use rate change calculation if configured
    const hasRateChangeForRow = interestRateChangeDate && interestRateBefore !== null && interestRateAfter !== null;

    if (hasRateChangeForRow) {
      const interestResult = calculateInterestWithRateChange(
        principalBase,
        baseDate,
        calcDate,
        interestRateChangeDate,
        interestRateBefore!,
        interestRateAfter!
      );
      currentInterest = interestResult.totalInterest || 0;
    } else {
      currentInterest = calculateInterest(principalBase, interestRate, baseDate, calcDate);
    }
    
    const supplementary = t.supplementaryAmount || 0;
    const totalAvailable = (principalBase || 0) + (currentInterest || 0) + (supplementary || 0);

    // Determine date display - use effective status
    let displayDateStr = '';
    if (isDisbursed && t.disbursementDate) {
      displayDateStr = formatDate(t.disbursementDate);
    } else if (baseDate) {
      displayDateStr = formatDate(baseDate);
    }

    // Ensure all values are properly converted to avoid [object Object]
    const projectCode = project ? (typeof project.code === 'string' ? project.code : String(project.code || '')) : (typeof t.projectId === 'string' ? t.projectId : String(t.projectId || ''));
    
    // Tổng chi trả:
    // - Chưa GN: luôn dùng totalAvailable để SUM khớp stats "Tiền chưa GN"
    // - Đã GN: ưu tiên disbursedTotal (đã chốt), nhưng nếu dữ liệu cũ bị làm tròn mất phần lẻ
    //   thì fallback sang tổng tính lại (gốc + lãi + bổ sung) theo đúng ngày chốt.
    const storedDisbursedTotal = Number((t as any).disbursedTotal);
    const computedTotalPaid = roundTo2(totalAvailable);
    const displayTotalPaid =
      isDisbursed && isFinite(storedDisbursedTotal) && storedDisbursedTotal > 0
        ? (Math.abs(roundTo2(storedDisbursedTotal) - computedTotalPaid) >= 0.01
            ? computedTotalPaid
            : roundTo2(storedDisbursedTotal))
        : computedTotalPaid;
    const withdrawnAmountVal = (t as any).withdrawnAmount || 0;
    
    // Tiền còn lại: chỉ hiển thị nếu đã rút một phần - Y XÌ BẢNG
    const remainingCol = (t as any).remainingAfterWithdraw !== undefined && (t as any).withdrawnAmount
      ? totalAvailable  // Tổng tiền thực nhận mới = principalForInterest + lãi_mới + supplementary
      : null;
    
    rows.push([
      Number(t.stt || index + 1) || 0,
      String(t.id || ''),
      String(t.household?.id || ''),
      projectCode,
      String(t.household?.name || ''),
      String(t.paymentType || '-'),
      String(t.household?.decisionNumber || '-'),
      displayDateStr,
      Number(principalBase) || 0,
      Number(currentInterest) || 0,
      Number(supplementary) || 0,
      withdrawnAmountVal > 0 ? Number(withdrawnAmountVal) : '',
      Number(displayTotalPaid) || 0,
      remainingCol !== null ? Number(remainingCol) || 0 : '',
      String(effectiveStatus || '')
    ]);
  });

  // Convert to Excel format
  const fileName = `Bao_cao_giao_dich_${formatTz(getVNNow(), 'yyyy-MM-dd', { timeZone: VN_TIMEZONE })}.xlsx`;

  downloadExcel(rows, fileName).catch(err => {
    console.error('Error exporting to Excel:', err);
    alert('Lỗi khi xuất file Excel: ' + (err?.message || 'Unknown error'));
  });
};

export const exportAuditLogsToExcel = (auditLogs: AuditLogItem[]) => {
  const rows = [];
  rows.push(['NHẬT KÝ HOẠT ĐỘNG HỆ THỐNG (AUDIT LOG)', `Ngày xuất: ${formatTz(getVNNow(), 'dd/MM/yyyy', { timeZone: VN_TIMEZONE })}`]);
  rows.push([]);
  rows.push(['ID', 'Thời gian', 'Người thực hiện', 'Vai trò', 'Hành động', 'Đối tượng', 'Chi tiết']);

  // Export all logs
  auditLogs.forEach(log => {
    rows.push([
      log.id,
      formatTz(toVNTime(log.timestamp), 'dd/MM/yyyy HH:mm:ss', { timeZone: VN_TIMEZONE }),
      log.actor,
      log.role,
      log.action,
      log.target,
      log.details // No need to escape for Excel
    ]);
  });

  const fileName = `Audit_Log_${formatTz(getVNNow(), 'yyyy-MM-dd', { timeZone: VN_TIMEZONE })}.xlsx`;

  downloadExcel(rows, fileName).catch(err => {
    console.error('Error exporting to Excel:', err);
    alert('Lỗi khi xuất file Excel: ' + (err?.message || 'Unknown error'));
  });
};

export const exportProjectsToExcel = (
  projects: Project[],
  transactions: Transaction[],
  interestRate: number,
  interestRateChangeDate?: string | null,
  interestRateBefore?: number | null,
  interestRateAfter?: number | null
) => {
  // Helper to calculate interest with rate change if configured
  const calculateInterestSmart = (
    principal: number,
    baseDate: string | undefined,
    endDate: Date
  ): number => {
    const hasRateChange = interestRateChangeDate && interestRateBefore !== null && interestRateAfter !== null;
    if (hasRateChange && baseDate) {
      const interestResult = calculateInterestWithRateChange(
        principal,
        baseDate,
        endDate,
        interestRateChangeDate,
        interestRateBefore!,
        interestRateAfter!
      );
      return interestResult.totalInterest;
    }
    if (baseDate) {
      return calculateInterest(principal, interestRate, baseDate, endDate);
    }
    return 0;
  };

  // Helper to calculate actual total budget for a project
  const getProjectActualTotal = (project: Project): number => {
    const projectTrans = transactions.filter(t => {
      const pIdStr = (t.projectId && (t.projectId as any)._id) ? (t.projectId as any)._id.toString() : t.projectId?.toString();
      return pIdStr === project.id || pIdStr === (project as any)._id;
    });
    
    const actualTotal = projectTrans.reduce((sum, t) => {
      const supplementary = t.supplementaryAmount || 0;
      
      if (t.status === TransactionStatus.DISBURSED && (t as any).disbursedTotal) {
        return sum + (t as any).disbursedTotal;
      }
      
      const baseDate = t.effectiveInterestDate || project.interestStartDate;
      let interest = 0;
      if (t.status === TransactionStatus.DISBURSED && t.disbursementDate) {
        interest = calculateInterestSmart(t.compensation.totalApproved, baseDate, new Date(t.disbursementDate));
      } else if (t.status !== TransactionStatus.DISBURSED) {
        const principalBase = (t as any).principalForInterest ?? t.compensation.totalApproved;
        interest = calculateInterestSmart(principalBase, baseDate, new Date());
      }
      return sum + (t.compensation.totalApproved || 0) + interest + supplementary;
    }, 0);
    
    return actualTotal > 0 ? actualTotal : project.totalBudget;
  };

  // Build Excel data
  const rows = [];

  // Header
  rows.push(['BÁO CÁO TỔNG HỢP DỰ ÁN', `Ngày xuất: ${formatTz(getVNNow(), 'dd/MM/yyyy', { timeZone: VN_TIMEZONE })}`]);
  rows.push([]); // Empty row
  rows.push(['THỐNG KÊ TỔNG QUAN']);
  rows.push(['Tổng số dự án', 'Tổng giá trị dự án']);
  
  const totalValue = projects.reduce((acc, p) => acc + getProjectActualTotal(p), 0);
  rows.push([
    Number(projects.length) || 0,
    Number(totalValue) || 0
  ]);
  rows.push([]); // Empty row
  rows.push([]); // Empty row

  // Details Table Header
  rows.push(['DANH SÁCH CHI TIẾT']);
  rows.push([
    'STT',
    'Mã dự án',
    'Tên dự án',
    'Ngày bắt đầu tính lãi',
    'Tổng ngân sách',
    'Tổng giá trị thực tế',
    'Số hộ',
    'Số hộ đã giải ngân',
    'Số hộ chưa giải ngân',
    'Tiền đã giải ngân',
    'Tiền chưa giải ngân',
    'Tỷ lệ giải ngân (%)'
  ]);

  // Add project rows
  projects.forEach((project, index) => {
    const projectTrans = transactions.filter(t => {
      const pIdStr = (t.projectId && (t.projectId as any)._id) ? (t.projectId as any)._id.toString() : t.projectId?.toString();
      return pIdStr === project.id || pIdStr === (project as any)._id;
    });

    // Tổng đã giải ngân (bao gồm cả giải ngân hoàn toàn và rút một phần)
    const disbursedFull = projectTrans
      .filter(t => t.status === TransactionStatus.DISBURSED)
      .reduce((acc, t) => {
        if ((t as any).disbursedTotal) {
          return acc + (t as any).disbursedTotal;
        }
        const baseDate = t.effectiveInterestDate || project.interestStartDate;
        let interest = 0;
        if (t.disbursementDate) {
          interest = calculateInterestSmart(t.compensation.totalApproved, baseDate, new Date(t.disbursementDate));
        }
        return acc + (t.compensation.totalApproved || 0) + interest + (t.supplementaryAmount || 0);
      }, 0);

    const disbursedPartial = projectTrans
      .filter(t => t.status !== TransactionStatus.DISBURSED && (t as any).withdrawnAmount)
      .reduce((acc, t) => acc + ((t as any).withdrawnAmount || 0), 0);

    const disbursed = disbursedFull + disbursedPartial;

    // Tính tổng giá trị dự án thực tế
    const actualTotalBudget = getProjectActualTotal(project);

    const percent = actualTotalBudget > 0 ? (disbursed / actualTotalBudget) * 100 : 0;

  rows.push([
    Number(index + 1) || 0,
    String(project.code || ''),
    String(project.name || ''),
    project.interestStartDate ? formatDate(project.interestStartDate) : '',
    Number(project.totalBudget) || 0,
    Number(actualTotalBudget) || 0,
    Number(projectTrans.length) || 0,
    Number(projectTrans.filter(t => t.status === TransactionStatus.DISBURSED).length) || 0,
    Number(projectTrans.filter(t => t.status !== TransactionStatus.DISBURSED).length) || 0,
    Number(disbursed) || 0,
    Number(actualTotalBudget - disbursed) || 0,
    String(percent.toFixed(1) + '%')
  ]);
  });

  const fileName = `Bao_cao_du_an_${formatTz(getVNNow(), 'yyyy-MM-dd', { timeZone: VN_TIMEZONE })}.xlsx`;

  downloadExcel(rows, fileName).catch(err => {
    console.error('Error exporting to Excel:', err);
    alert('Lỗi khi xuất file Excel: ' + (err?.message || 'Unknown error'));
  });
};
