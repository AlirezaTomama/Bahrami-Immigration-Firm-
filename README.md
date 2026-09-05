# Bahrami Immigration — Digital Immigration Advisory Platform

**Bilingual (English / فارسی) single-file prototype** for redesigning [immigration-visa.ca](https://immigration-visa.ca) — the website of Bahrami Immigration Firm (Arash Bahrami, RCIC #R418351, Vancouver & Tehran) — from a static brochure site into a **client-acquisition and advisory platform**.

**Live demo:** enable GitHub Pages on this repo (see [Deploy](#deploy)).

---

## The idea

Most immigration firm websites are online brochures: service lists, a contact form, and a "book a consultation" button as the very first ask. This prototype flips the model into a guided funnel:

> **Discover → Assess → Compare → Understand → Trust → Book → Onboard → Track**

The visitor gets real value *before* being asked for money: a genuine eligibility assessment against current rules, their actual CRS score, honest cost numbers, and a personalized reading of the latest draws. Booking a consultation is **step 3, not step 1** — by then the visitor knows their options and arrives with a pre-filled intake.

The product is designed in three layers:

1. **Public website** — trust, services, verified consultant credentials (live link to the CICC Public Register)
2. **Decision engine** — profile → rules engine → eligibility result, CRS, gaps, recommended action
3. **Client workspace** — dashboard, dynamic checklist, document upload, case timeline, alerts

## What's inside (20 features / 7 sprints)

| Sprint | Scope | Status in this prototype |
|---|---|---|
| 1 — Foundation & Trust | Homepage, problem-first services ("I want to…"), contextual CTAs, consultant verification, structured success stories, SEO schema | ✅ Functional (CMS & lead capture are backend work) |
| 2 — Eligibility Engine | 5-step smart assessment, program matching with exact missing requirements, full CRS calculator (single + with-spouse) | ✅ Fully functional, client-side |
| 3 — Immigration Data Layer | Single `DATA` object for draws, fees, funds, processing times, rule updates — UI only consumes it, nothing hard-coded in components | ✅ Functional (production swaps in an API/CMS) |
| 4 — Conversion | Refusal Centre (dynamic actions by type & reasons, GCMS, JR deadlines, letter upload), booking flow with consultant/time/intake | ✅ UX complete; Stripe / calendar / Zoom are labeled stubs |
| 5 — Client Portal | Login-gated dashboard, checklist **generated live from the profile**, working in-session document upload, adaptive pathway timeline | ✅ Functional in-session (storage/auth are backend) |
| 6 — Personalization | "Your CRS is N points below the cut-off range"-style computed insights, sector-aware BC PNP alerts, pre-client dashboard | ✅ Functional |
| 7 — AI + Hardening | Grounded AI Guide (answers only from the user profile + platform rules data, bilingual, fixed legal-boundary line), audit log | ✅ Works inside Claude artifacts; on static hosting needs a small API proxy |

## Rules accuracy (verified September 2026)

The engine encodes the **post-2025 reality**, not stale training data:

- **Job offer = 0 CRS points** (removed Mar 25, 2025; possible return signalled by IRCC — flagged to the user, not counted)
- Official CRS grids for single and with-spouse profiles, transferability capped at 100, French +25/+50, Canadian credential +15/+30, sibling +15, PN +600
- FSW **67-point selection grid** implemented separately (still in force)
- CEC criteria (CLB 7/5 by TEER, no proof of funds), FSW, FST
- **Start-Up Visa closed Jan 1, 2026** — shown explicitly, with the real alternatives (BC Entrepreneur Base $600K / Regional $300K, C11)
- **BC PNP 2026 pivot** ("Care, Build, Innovate"): ELSS closed, allocation ≈ 5,254, $2,000 fee, wage-weighted SIRS
- **Fees after Apr 30, 2026**: EE principal $990 + RPRF $600 = $1,590
- Proof of funds 2026: $15,263 single / $28,362 family-of-4 (CEC exempt); study permit $23,448 from Sep 1, 2026
- 2026 category-based draws (French, healthcare, education, trades) — gated correctly on pool eligibility

Age bands use band-representative values (disclosed in the UI); processing times are labeled illustrative pending the live IRCC feed.

## Tech

- One `index.html` — zero dependencies, no build step, no framework
- Hash-based SPA routing (`#/assess`, `#/programs`, …) — works on any static host
- Full i18n: EN/FA toggle, RTL layout, Vazirmatn for Persian; **engine output is bilingual too** (match cards, checklist, timeline, refusal actions)
- Real brand assets: embedded logo, real office addresses, real social links, RCIC licence + CICC verify link in the footer
- Responsive: 900 / 640 / 380 px breakpoints, scrollable mobile nav

## Deploy

1. Put `index.html` at the repo root on `main`.
2. **Settings → Pages → Deploy from a branch → `main` / `(root)`**.
3. Live at `https://<username>.github.io/<repo>/` in ~1 minute.

## Honest limitations

This is a **front-end spec that runs**, not a production system. Payment, calendar sync, real authentication, encrypted document storage, CMS, lead capture, and the AI proxy are backend work — every stub is labeled in the UI. Hash routing should become real URLs (SSR/SSG) before SEO matters. Sample figures are marked as such. Nothing here is legal advice.

---

## فارسی — این پروژه چیست؟

پروتوتایپ **بازطراحی سایت سازمان مهاجرتی بهرامی** (آرش بهرامی، RCIC #R418351، ونکوور و تهران): تبدیل یک سایت بروشوری به **پلتفرم جذب و مشاوره موکل**.

ایده اصلی: بازدیدکننده قبل از اینکه ازش پول خواسته شود، ارزش واقعی بگیرد — ارزیابی واقعی شرایط با قوانین روز، امتیاز CRS واقعی از جدول رسمی، هزینه‌های شفاف، و تفسیر شخصی آخرین دراوها. رزرو مشاوره **قدم سوم است، نه قدم اول** — مسیر سه‌قدمی: **ارزیابی ← مقایسه ← رزرو**.

هر ۷ اسپرینت (۲۰ فیچر) پیاده شده: موتور قوانین با شروط دقیق سپتامبر ۲۰۲۶ (حذف امتیاز جاب آفر، بسته شدن استارت‌آپ ویزا، چرخش BC PNP، فی‌های جدید آوریل ۲۰۲۶)، محاسبه‌گر CRS کامل مجرد/متاهل، محاسبه‌گر هزینه، مرکز ریجکتی داینامیک، پورتال موکلین با لاگین و چک‌لیستی که زنده از پروفایل ساخته می‌شود، شخصی‌سازی («N امتیاز زیر کات‌آف هستید»)، و دستیار هوشمند دوزبانه که فقط از پروفایل کاربر و لایه قوانین جواب می‌دهد.

کل سایت **دوزبانه انگلیسی/فارسی** است — با سوییچ زبان، چیدمان RTL و خروجی فارسیِ خود موتورها، نه فقط متن‌های ثابت.

محدودیت صادقانه: پرداخت، تقویم، احراز هویت واقعی، ذخیره‌سازی مدارک و CMS کار بک‌اند است و همه‌جا با برچسب «استاب» مشخص شده. این فایل، اسپکِ اجراشدنیِ فرانت‌اند برای تیم توسعه است.
