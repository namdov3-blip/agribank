import { toZonedTime } from 'date-fns-tz';

const VN_TIMEZONE = 'Asia/Ho_Chi_Minh';

/**
 * Helper: Convert date to VN timezone and get start of day
 */
export const getVNStartOfDay = (date: Date | string): Date => {
  const d = typeof date === 'string' ? new Date(date) : date;
  const vnDate = toZonedTime(d, VN_TIMEZONE);
  vnDate.setHours(0, 0, 0, 0);
  return vnDate;
};

/**
 * Tính lãi theo cách của ngân hàng: lãi nhập gốc theo từng kỳ (tháng)
 * Mỗi kỳ tính lãi dựa trên số dư đầu kỳ, sau đó cộng lãi vào gốc để tính kỳ tiếp theo
 * 
 * Ví dụ từ phiếu ngân hàng:
 * - Kỳ 1 (21/08-01/09): Số dư 97,923,200 → Lãi 2,951 → Số dư mới 97,926,151
 * - Kỳ 2 (01/09-01/10): Số dư 97,926,151 → Lãi 8,049 → Số dư mới 97,934,200
 * - Kỳ 3 (01/10-01/11): Số dư 97,934,200 → Lãi 8,318 → Số dư mới 97,942,518
 * 
 * @param principal - Số tiền gốc
 * @param annualRate - Lãi suất năm (%)
 * @param startDate - Ngày bắt đầu tính lãi
 * @param endDate - Ngày kết thúc tính lãi
 * @returns Tổng lãi đã tính
 */
export const calculateInterest = (
    principal: number,
    annualRate: number,
    startDate: Date | string | undefined,
    endDate: Date
): number => {
    if (!startDate) return 0;

    // Handle different date input types
    let baseDate: Date;
    if (startDate instanceof Date) {
        baseDate = new Date(startDate);
    } else if (typeof startDate === 'object') {
        return 0;
    } else {
        baseDate = new Date(startDate);
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
    const dailyRate = (annualRate / 100) / 365;

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
 * @param baseDate - Ngày bắt đầu tính lãi
 * @param endDate - Ngày kết thúc tính lãi
 * @param rateChangeDate - Ngày thay đổi lãi suất (ví dụ: 01/01/2026)
 * @param rateBefore - Lãi suất trước mốc (%)
 * @param rateAfter - Lãi suất sau mốc (%)
 * @returns Tổng lãi và chi tiết 2 giai đoạn
 */
export const calculateInterestWithRateChange = (
    principal: number,
    baseDate: Date | string | undefined,
    endDate: Date,
    rateChangeDate: Date | string,
    rateBefore: number,
    rateAfter: number
): { 
    totalInterest: number; 
    interestBefore: number; 
    interestAfter: number;
    balanceAtChange: number; // Số dư tại mốc thay đổi (gốc + lãi trước mốc)
} => {
    if (!baseDate) {
        return {
            totalInterest: 0,
            interestBefore: 0,
            interestAfter: 0,
            balanceAtChange: principal
        };
    }

    const baseDateVN = getVNStartOfDay(baseDate);
    const endDateVN = getVNStartOfDay(endDate);
    const changeDateVN = getVNStartOfDay(rateChangeDate);

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
