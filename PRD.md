# PRD – Hệ thống Quản lý Giao dịch (Transaction Management System)

**Phiên bản:** 1.0  
**Mục đích:** Tài liệu yêu cầu sản phẩm để clone và triển khai cho đơn vị khác với chức năng tương tự.

---

## 1. Tổng quan sản phẩm

### 1.1 Mô tả

Hệ thống **Quản lý Giao dịch** là ứng dụng web dùng để:

- Quản lý **dự án** và **giao dịch giải ngân** (bồi thường, hỗ trợ) theo từng đơn vị (organization).
- Theo dõi **số dư ngân hàng nội bộ** (nạp/rút/điều chỉnh) và **lãi** (lãi bồi thường cho người nhận, lãi tiền gửi ngân hàng).
- Hỗ trợ **giải ngân** (thủ công trên web hoặc xác nhận qua **link/QR**), **hoàn tiền**, **rút một phần**, **bổ sung**.
- **Import Excel** để tạo dự án và danh sách hộ/giao dịch.
- **Phân quyền** theo vai trò và đơn vị; **audit log** cho hành động quan trọng.

**Domain hiện tại:** Bồi thường/giải ngân (Agribank). Có thể tái sử dụng cho đơn vị khác cùng nghiệp vụ (nhiều đơn vị, nhiều dự án, giao dịch có trạng thái và lãi).

### 1.2 Đối tượng sử dụng

| Đối tượng | Mô tả |
|-----------|--------|
| **SuperAdmin** | Xem toàn bộ đơn vị; quản trị hệ thống. |
| **Admin** | Quản trị; xem tất cả dự án/giao dịch; cấu hình lãi suất, user. |
| **User (User1, User2, PMB)** | Nhân viên đơn vị; chỉ xem và thao tác dữ liệu thuộc **organization** của mình. |
| **Người nhận tiền / Cán bộ hiện trường** | Xác nhận giải ngân qua link/QR (không bắt buộc đăng nhập). |

---

## 2. Mục tiêu & Phạm vi

### 2.1 Mục tiêu

- Quản lý dự án và giao dịch theo đơn vị, trạng thái (Chưa giải ngân / Đã giải ngân / Tồn đọng).
- Quản lý số dư ngân hàng nội bộ (mở đầu, nạp, rút, điều chỉnh) và lãi theo từng đơn vị.
- Tính lãi bồi thường (theo tháng, có mốc thay đổi lãi suất) và lãi tiền gửi ngân hàng.
- Giải ngân (web + QR/link), hoàn, rút một phần, bổ sung; in phiếu chi, QR.
- Import Excel (dự án + giao dịch); audit log; phân quyền rõ ràng.

### 2.2 Phạm vi (trong PRD)

- Toàn bộ tính năng hiện có của codebase (dashboard, dự án, số dư, giao dịch, tính lãi, admin, xác nhận QR).
- Không bao gồm: tích hợp kế toán ngoài, chữ ký số, tích hợp ngân hàng thật (chỉ mô phỏng số dư nội bộ).

---

## 3. Công nghệ & Kiến trúc

### 3.1 Stack

| Thành phần | Công nghệ |
|------------|-----------|
| **Frontend** | React 18, Vite 6, React Router 7, TypeScript |
| **Backend** | Node.js 22, Express 5, TypeScript |
| **Cơ sở dữ liệu** | MongoDB (Mongoose 8.x); có thể dùng MongoDB Atlas |
| **Xác thực** | JWT (jsonwebtoken), bcrypt cho mật khẩu |
| **Deploy** | Local (Express) + Vercel (serverless API) tùy chọn |

### 3.2 Chạy ứng dụng

- **Dev:** Frontend port **3000**, proxy `/api` → Backend **3001**.
- **Scripts:** `npm run dev` (cả hai), `npm run dev:server`, `npm run dev:frontend`, `npm run build`, `npm run preview`.

### 3.3 Biến môi trường

| Biến | Mô tả |
|------|--------|
| `MONGODB_URI` | Connection string MongoDB (Atlas hoặc local). |
| `JWT_SECRET` | Secret ký JWT. |
| `FRONTEND_URL` | URL frontend (CORS / redirect). |
| `GEMINI_API_KEY` | (Tuỳ chọn) Nếu dùng tính năng AI. |

---

## 4. Chức năng chi tiết

### 4.1 Đăng nhập & Phiên

- **Đăng nhập:** Tên đăng nhập + mật khẩu; trả JWT + thông tin user.
- **Mặc định:** Lần đầu chạy có thể tạo user Admin (ví dụ: "Quản trị viên" / "admin"); **đổi mật khẩu ngay sau lần đăng nhập đầu**.
- **Refresh token:** Gia hạn phiên (token 1h, refresh khi gần hết hạn).
- **Idle timeout:** Tự đăng xuất khi không thao tác (ví dụ 10 phút) – tùy cấu hình frontend.

### 4.2 Dashboard (Tổng quan)

- Thống kê: số giao dịch, dự án, số dư (theo quyền).
- Pipeline/trạng thái: Chưa giải ngân, Tồn đọng, Đã giải ngân.
- Có thể dùng long polling (`/api/events/poll`) cho cập nhật gần realtime.

### 4.3 Dự án (Projects)

- **CRUD** dự án: mã, tên, địa điểm, tổng ngân sách, ngày bắt đầu, ngày bắt đầu tính lãi, trạng thái (Active / Completed / Planning), **organization**.
- **Import Excel:** Tạo dự án + danh sách hộ/giao dịch từ file; mapping cột (hộ, CCCD, địa chỉ, diện tích, QĐ, tiền đất/nhà/tài sản/hỗ trợ, tổng duyệt…); hỗ trợ **tạo mới** hoặc **merge**.
- Dự án gắn **organization** (lấy từ user đăng nhập khi import hoặc chọn khi tạo).

### 4.4 Số dư ngân hàng (Bank Balance)

- **Số dư mở đầu** (theo đơn vị); **điều chỉnh số dư mở đầu** (tái tính running balance cho đơn vị đó).
- **Nạp tiền / Rút tiền / Điều chỉnh:** Mỗi giao dịch ngân hàng có type, amount, date, note, **runningBalance**, **organization**.
- Lịch sử giao dịch ngân hàng theo đơn vị (user chỉ xem đơn vị mình; Admin/SuperAdmin xem tất cả).
- **Lãi tiền gửi ngân hàng:** Lãi suất cấu hình trong Settings; trích lãi định kỳ (ví dụ tháng) theo từng org (`/api/bank/accrue-interest`).

### 4.5 Giao dịch (Transactions)

- **Danh sách:** Lọc theo dự án, trạng thái, tìm kiếm; phân trang.
- **Trạng thái:** Chưa giải ngân | Đã giải ngân | Tồn đọng/Giữ hộ.
- **Chi tiết giao dịch:** Hộ (id, tên, CCCD, địa chỉ, nguồn gốc đất, diện tích, số QĐ, ngày QĐ); khoản bồi thường (đất, tài sản, nhà, hỗ trợ, tổng duyệt); ngày giải ngân; ngày hiệu lực lãi; tiền đã giải ngân, đã rút, còn lại, gốc tính lãi; lịch sử thao tác.
- **Thao tác:**
  - **Giải ngân:** Đổi trạng thái sang "Đã giải ngân", nhập ngày giải ngân (tùy chọn) → tạo bút toán Rút tiền (BankTransaction), cập nhật lãi.
  - **Hoàn tiền (refund):** Một phần hoặc toàn bộ → bút toán Nạp tiền, cập nhật giao dịch.
  - **Rút một phần (withdraw):** Cập nhật withdrawnAmount, remainingAfterWithdraw, principalForInterest.
  - **Bổ sung (supplement):** Cộng thêm tiền; có thể tạo Rút tiền tương ứng.
- **In phiếu chi / QR:** Tạo link + mã QR (JWT 24h, có thể gắn ngày giải ngân); trang xác nhận công khai GET/POST bằng token (không bắt buộc đăng nhập).

### 4.6 Tính lãi dự kiến (Interest Calculator)

- Công cụ tính lãi dự kiến theo lãi suất và mốc thay đổi lãi suất (phục vụ báo cáo / tham chiếu).

### 4.7 Admin

- **User:** CRUD user; gán role, permissions, **organization**.
- **Lãi suất:** Cập nhật lãi suất bồi thường (và mốc thay đổi lãi suất); lãi suất tiền gửi ngân hàng; xem lịch sử lãi suất.
- **Audit log:** Xem nhật ký hành động (actor, role, action, target, details).
- **Reset dữ liệu:** Endpoint admin (cẩn thận khi dùng production).

### 4.8 Xác nhận giải ngân qua QR/Link

- **GET** `/api/transactions/confirm/:token`: Xem thông tin giao dịch (có thể không cần đăng nhập).
- **POST** `/api/transactions/confirm/:token`: Xác nhận giải ngân → logic giống giải ngân trên web (trạng thái, bút toán Rút tiền, audit).

---

## 5. Phân quyền & Đơn vị

### 5.1 Vai trò (role)

| Role | Mô tả |
|------|--------|
| **SuperAdmin** | Toàn quyền; xem mọi organization. |
| **Admin** | Quản trị; xem tất cả dự án/giao dịch/số dư (không lọc theo org trong một số API). |
| **User1, User2, PMB** | User thường; dữ liệu **chỉ** thuộc **organization** của user. |

**Đặc biệt:** User có **organization = "Nam World"** được coi như xem toàn bộ (tương tự SuperAdmin) trong logic lọc.

### 5.2 Permissions (menu / tính năng)

- `dashboard` – Tổng quan  
- `projects` – Dự án  
- `balance` – Số dư  
- `transactions` – Giao dịch  
- `reports` – (dự phòng)  
- `admin` – Màn Admin  

Admin/SuperAdmin: hiển thị toàn bộ menu. User khác: menu lọc theo `currentUser.permissions`. Màn **Tính lãi dự kiến** hiển thị nếu có `transactions` hoặc `balance` hoặc `interestCalc`.

### 5.3 Bảo vệ API

- Hầu hết API dùng **authMiddleware**: JWT bắt buộc; có thể giới hạn theo `allowedRoles`.
- Ngoại lệ: Login, Confirm QR (chỉ cần token hợp lệ trong URL).

### 5.4 Danh sách đơn vị (Organization)

- **User:** `ORGANIZATIONS` = `['Đông Anh', 'Phúc Thịnh', 'Thiên Lộc', 'Thư Lâm', 'Vĩnh Thanh', 'Nam World']`.
- **Project:** Cùng enum **trừ** "Nam World" (dự án chỉ gắn 5 đơn vị; "Nam World" dùng cho user xem toàn cục).

Khi clone cho đơn vị khác: sửa hằng số `ORGANIZATIONS` trong `lib/models/User.ts` và `lib/models/Project.ts` cho phù hợp.

---

## 6. Mô hình dữ liệu chính

### 6.1 User

- `name`, `password` (hash), `role`, `avatar`, `permissions[]`, **organization**, `createdAt`.

### 6.2 Project

- `code` (unique), `name`, `location`, `totalBudget`, `startDate`, `uploadDate`, `interestStartDate`, `status`, **organization**, `uploadedBy` (ref User).

### 6.3 Transaction

- `projectId` (ref Project), **household** (id, name, cccd, address, landOrigin, landArea, decisionNumber, decisionDate), **compensation** (landAmount, assetAmount, houseAmount, supportAmount, totalApproved), `paymentType`, `status`, `disbursementDate`, `effectiveInterestDate`, `supplementaryAmount`, `disbursedTotal`, `withdrawnAmount`, `remainingAfterWithdraw`, `principalForInterest`, `notes`, `history[]`, `stt`.

### 6.4 BankTransaction

- `type` (Nạp tiền | Rút tiền | Điều chỉnh), `amount`, `date`, `note`, `createdBy`, **runningBalance**, **organization**, `projectId` (optional).

### 6.5 Settings (key = 'global')

- `interestRate`, `interestRateChangeDate`, `interestRateBefore`, `interestRateAfter`, `interestHistory[]`, `bankOpeningBalance`, `bankInterestRate`, `lastBankInterestAccrued`.

### 6.6 AuditLog

- `timestamp`, `actor`, `role`, `action`, `target`, `details`.

**Lưu ý:** Số dư ngân hàng và lãi ngân hàng **tính riêng theo từng organization** (chuỗi BankTransaction theo org; runningBalance bản ghi cuối = số dư hiện tại).

---

## 7. API tóm tắt

| Nhóm | Method | Endpoint | Mô tả |
|------|--------|----------|--------|
| **Auth** | POST | `/api/auth/login` | Đăng nhập |
| | GET | `/api/auth/me` | Thông tin user (JWT) |
| | POST | `/api/auth/refresh` | Gia hạn phiên |
| **Projects** | GET, POST | `/api/projects` | Danh sách / Tạo |
| | GET, PUT, DELETE | `/api/projects/:id` | Chi tiết / Cập nhật / Xóa |
| | POST | `/api/projects/import` | Import Excel |
| **Transactions** | GET | `/api/transactions` | Danh sách (lọc, trang) |
| | GET, PUT, DELETE | `/api/transactions/:id` | Chi tiết / Cập nhật / Xóa |
| | PUT | `/api/transactions/:id/status` | Đổi trạng thái (giải ngân) |
| | POST | `/api/transactions/:id/refund` | Hoàn tiền |
| | POST | `/api/transactions/:id/withdraw` | Rút một phần |
| | POST | `/api/transactions/:id/supplement` | Bổ sung |
| | GET | `/api/transactions/:id/qr` | Tạo QR/link xác nhận |
| | GET, POST | `/api/transactions/confirm/:token` | Xem / Xác nhận giải ngân (QR) |
| **Bank** | GET | `/api/bank/balance` | Số dư (theo org) |
| | GET, POST | `/api/bank/transactions` | Lịch sử / Thêm giao dịch |
| | POST | `/api/bank/adjust-opening` | Điều chỉnh số dư mở đầu |
| | GET | `/api/bank/calculate-interest` | Tính lãi |
| | POST | `/api/bank/accrue-interest` | Trích lãi ngân hàng định kỳ |
| **Users** | GET, POST | `/api/users` | Danh sách / Tạo |
| | GET, PUT, DELETE | `/api/users/:id` | Chi tiết / Cập nhật / Xóa |
| **Settings** | GET, PUT | `/api/settings/interest-rate` | Lãi suất bồi thường |
| | PUT | `/api/settings/bank-interest-rate` | Lãi suất tiền gửi |
| **Khác** | GET | `/api/audit-logs` | Nhật ký hành động |
| | GET | `/api/events/poll` | Long polling (dashboard) |
| | POST | `/api/admin/reset` | Reset dữ liệu (admin) |
| | GET | `/api/health` | Health check |

---

## 8. Nghiệp vụ đặc thù

### 8.1 Lãi bồi thường (tiền giải ngân)

- Tính lãi **theo kỳ tháng** (số dư đầu kỳ × lãi suất × số ngày; lãi cộng vào gốc cho kỳ sau).
- Múi giờ: **Asia/Ho_Chi_Minh**.
- Có thể cấu hình **mốc thay đổi lãi suất** (interestRateChangeDate, interestRateBefore, interestRateAfter).
- Ngày bắt đầu tính lãi: ưu tiên `transaction.effectiveInterestDate`, không có thì `project.interestStartDate`.

### 8.2 Quy trình giải ngân

1. **Web:** Đổi trạng thái sang "Đã giải ngân" (+ ngày giải ngân tùy chọn) → tính lãi, tạo BankTransaction (Rút tiền), cập nhật transaction.
2. **QR/Link:** In phiếu chi với link/QR → người nhận/cán bộ mở link → GET xem, POST xác nhận → cùng logic giải ngân.

### 8.3 Import Excel

- Định dạng cột theo nghiệp vụ bồi thường (hộ, CCCD, địa chỉ, diện tích, QĐ, tiền đất/nhà/tài sản/hỗ trợ, tổng duyệt…).
- Parse số (VN/US), ngày (Excel serial, DD/MM/YYYY). Khi clone đơn vị khác có thể chỉnh **mapping cột** và validation trong `backend/handlers/projects/import.ts`.

---

## 9. Yêu cầu phi chức năng (gợi ý)

- **Bảo mật:** Mật khẩu hash (bcrypt); JWT có hạn; không lộ secret qua frontend.
- **Audit:** Ghi log hành động quan trọng (đăng nhập, tạo/sửa dự án, giải ngân, hoàn, rút, bổ sung, đổi lãi suất).
- **Hiệu năng:** Index MongoDB (organization, projectId, status, date…); phân trang danh sách.
- **Triển khai:** Có thể chạy local (Node 22) hoặc deploy API lên Vercel; frontend build tĩnh host riêng hoặc cùng Vercel.

---

## 10. Hướng dẫn clone cho đơn vị khác

Checklist tùy biến khi nhân bản hệ thống cho đơn vị khác (chức năng tương tự):

| Hạng mục | Việc cần làm |
|----------|----------------|
| **Branding** | Đổi tên hệ thống, logo, favicon, title (ví dụ `index.html`, Sidebar). |
| **Đơn vị (Organization)** | Sửa `ORGANIZATIONS` trong `lib/models/User.ts` và `lib/models/Project.ts` (thêm/bớt/sửa tên; giữ hoặc bỏ "Nam World" tùy nhu cầu xem toàn cục). |
| **Vai trò** | Giữ hoặc đổi tên SuperAdmin/Admin/User1/User2/PMB cho phù hợp quy chế nội bộ. |
| **Permissions** | Giữ cấu trúc (dashboard, projects, balance, transactions, admin, interestCalc) hoặc bổ sung/sửa tên theo màn hình mới. |
| **Lãi suất** | Giữ logic kỳ tháng + mốc thay đổi lãi suất; có thể mở rộng nhiều mốc hoặc bảng lãi suất nếu cần. |
| **Import Excel** | Kiểm tra định dạng cột mới; chỉnh mapping và parse trong `backend/handlers/projects/import.ts` (và validation). |
| **Cấu hình** | Tạo `.env.local` (hoặc env production): `MONGODB_URI`, `JWT_SECRET`, `FRONTEND_URL`. |
| **Deploy** | Chọn môi trường (chỉ local / Vercel / server riêng); đặt tên database/collection MongoDB theo tài liệu trong repo (ví dụ `HUONG_DAN_DATABASE_NAME.md`). |
| **Tài liệu** | Cập nhật README / hướng dẫn deploy cho đơn vị mới (tên dự án, URL, thông tin đăng nhập mặc định). |

Sau khi chỉnh Organizations và branding, các chức năng (dashboard, dự án, số dư, giao dịch, giải ngân, QR, hoàn/rút/bổ sung, lãi, admin, audit) hoạt động tương tự; chỉ cần đảm bảo dữ liệu mẫu và user mặc định phù hợp đơn vị mới.

---

## 11. Tài liệu tham khảo trong repo

- `README_DEPLOY.md` – Tổng hợp hướng dẫn deploy.
- `HUONG_DAN_DEPLOY_CHI_TIET.md` – Deploy local + Vercel chi tiết.
- `HUONG_DAN_MONGODB_COMPASS.md` – MongoDB Atlas và Compass.
- `HUONG_DAN_DATABASE_NAME.md` – Tên database và connection.
- `TOM_TAT_NHANH.md` – Tóm tắt nhanh và checklist.

---

*PRD này mô tả hệ thống hiện tại và đủ để clone triển khai cho đơn vị khác với chức năng tương tự; có thể bổ sung section "Phụ lục – Chi tiết API" hoặc "User stories" nếu cần.*
