# BÁO CÁO KIỂM TRA TÍNH LÃI

## Tổng quan
Đã kiểm tra toàn bộ logic tính lãi trong repository, đặc biệt tập trung vào:
- **Tổng lãi PS** (Lãi phát sinh)
- **Lãi tạm tính** (Provisional interest)
- **Lãi phát sinh** (Accrued interest)

## CÁC VẤN ĐỀ PHÁT HIỆN

### 🔴 VẤN ĐỀ NGHIÊM TRỌNG #1: BankBalance.tsx không hỗ trợ thay đổi lãi suất

**Vị trí:** `pages/BankBalance.tsx`

**Vấn đề:**
- Component `BankBalance` KHÔNG nhận props `interestRateChangeDate`, `interestRateBefore`, `interestRateAfter`
- Dòng 71 và 78 sử dụng `calculateInterest()` thay vì `calculateInterestWithRateChange()`
- Khi có cấu hình thay đổi lãi suất (ví dụ: 01/01/2026), BankBalance sẽ tính SAI lãi tạm tính

**Ảnh hưởng:**
- "Lãi tạm tính" trong tab Số dư tài khoản sẽ SAI nếu có mốc thay đổi lãi suất
- Không khớp với "Tổng lãi PS" trong tab Giao dịch và Dashboard

**Code hiện tại:**
```typescript
// Line 71 - SAI khi có rate change
const calculatedInterest = calculateInterest(t.compensation.totalApproved, interestRate, baseDate, new Date(t.disbursementDate));

// Line 78 - SAI khi có rate change  
tempInterest += calculateInterest(t.compensation.totalApproved, interestRate, baseDate, new Date());
```

**So sánh với các component khác:**
- ✅ `TransactionList.tsx` - Có hỗ trợ rate change (line 123, 130-139, 156-165)
- ✅ `Dashboard.tsx` - Có hỗ trợ rate change (line 69-83, 199-220)
- ❌ `BankBalance.tsx` - KHÔNG có hỗ trợ rate change

---

### ⚠️ VẤN ĐỀ #2: Có 2 implementation của hàm tính lãi

**Vị trí:**
- `lib/utils/interest.ts` (Backend)
- `utils/helpers.ts` (Frontend)

**Vấn đề:**
- Có 2 file riêng biệt chứa logic tính lãi
- Cần đảm bảo chúng đồng bộ 100%
- Nếu có sự khác biệt nhỏ sẽ gây ra tính toán không nhất quán giữa frontend và backend

**Khuyến nghị:**
- Nên kiểm tra kỹ xem 2 file có logic giống hệt nhau không
- Hoặc refactor để dùng chung 1 source

---

### ✅ LOGIC TÍNH LÃI KÉP - ĐÚNG

**Vị trí:** `lib/utils/interest.ts` và `utils/helpers.ts`

**Logic hiện tại:**
- ✅ Tính lãi theo từng kỳ tháng (compound interest)
- ✅ Lãi nhập gốc sau mỗi kỳ: `currentBalance += periodInterest`
- ✅ Tính lãi kỳ tiếp theo dựa trên số dư đã bao gồm lãi từ kỳ trước
- ✅ Làm tròn 2 chữ số thập phân: `Math.round(rawPeriodInterest * 100) / 100`

**Ví dụ từ code:**
```
Kỳ 1: Số dư 97,923,200 → Lãi 2,951 → Số dư mới 97,926,151
Kỳ 2: Số dư 97,926,151 → Lãi 8,049 → Số dư mới 97,934,200
Kỳ 3: Số dư 97,934,200 → Lãi 8,318 → Số dư mới 97,942,518
```

**Kết luận:** Logic lãi kép là ĐÚNG ✅

---

### ✅ LOGIC TỔNG LÃI PS - ĐÚNG

**Vị trí:** `pages/TransactionList.tsx` (line 174-218)

**Logic:**
- ✅ Chỉ tính lãi từ các giao dịch CHƯA giải ngân (PENDING + HOLD)
- ✅ Lãi đã chốt (DISBURSED) được tách riêng và không tính vào tổng lãi PS
- ✅ Hỗ trợ rate change đúng cách

**Code:**
```typescript
// Line 177-216
let tempInterest = 0; // Lãi tạm tính (chưa giải ngân)
let lockedInterest = 0; // Lãi đã chốt (đã giải ngân)

filtered.forEach(t => {
  if (t.status === TransactionStatus.DISBURSED && t.disbursementDate) {
    // Lãi đã chốt - không tính vào tổng lãi PS
    lockedInterest += interestResult.totalInterest;
  } else if (t.status !== TransactionStatus.DISBURSED) {
    // Lãi tạm tính - tính vào tổng lãi PS
    tempInterest += interestResult.totalInterest;
  }
});

const totalInterest = tempInterest; // Chỉ trả về lãi tạm tính
```

**Kết luận:** Logic tổng lãi PS là ĐÚNG ✅

---

### ✅ LOGIC LÃI TẠM TÍNH - ĐÚNG (nhưng thiếu rate change)

**Vị trí:** `pages/Dashboard.tsx` (line 165-191)

**Logic:**
- ✅ Tính lãi từ các giao dịch chưa giải ngân đến ngày hiện tại
- ✅ Hỗ trợ rate change đúng cách
- ✅ Tách biệt lãi đã chốt và lãi tạm tính

**Kết luận:** Logic lãi tạm tính trong Dashboard là ĐÚNG ✅

---

## TÓM TẮT

### ✅ ĐÚNG:
1. Logic tính lãi kép (compound interest) - ĐÚNG
2. Logic tổng lãi PS trong TransactionList - ĐÚNG
3. Logic lãi tạm tính trong Dashboard - ĐÚNG
4. Hỗ trợ thay đổi lãi suất trong TransactionList và Dashboard - ĐÚNG

### ❌ SAI:
1. **BankBalance.tsx không hỗ trợ thay đổi lãi suất** - NGHIÊM TRỌNG
   - Khi có mốc thay đổi lãi suất, "Lãi tạm tính" trong tab Số dư sẽ SAI
   - Không khớp với các tab khác

### ⚠️ CẦN KIỂM TRA:
1. Đảm bảo `lib/utils/interest.ts` và `utils/helpers.ts` có logic giống hệt nhau

---

## KHUYẾN NGHỊ SỬA LỖI

### Ưu tiên cao:
1. **Sửa BankBalance.tsx** để hỗ trợ rate change:
   - Thêm props: `interestRateChangeDate`, `interestRateBefore`, `interestRateAfter`
   - Thay `calculateInterest()` bằng `calculateInterestWithRateChange()` khi có rate change
   - Cập nhật App.tsx để truyền các props này vào BankBalance

### Ưu tiên trung bình:
2. Kiểm tra và đồng bộ 2 file tính lãi (`lib/utils/interest.ts` và `utils/helpers.ts`)
