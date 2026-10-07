# Staff Timesheet Report — what I built and how to use it

## What it is
I added a new page called **Staff Timesheet Report**. It produces one complete timesheet per staff member for a pay period (or any date range), laid out so it can be printed, signed by the employee and the Program Manager, and filed.

I get to it two ways:
- **Timesheet Log → "Staff Report" button** (next to Print Timesheet). It carries over whatever pay period, house and staff member I already had filtered.
- **Reports → Staff Timesheet Report** in the left menu.

## What is on each sheet
1. **Header** — the pay period, and whether this is a **Draft** (period still open or payroll not confirmed) or **Final** (payroll confirmed, with who and when).
2. **Employee block** — name, staff ID, position, employment type, home house, status, pay rate.
3. **Summary** — hours worked, regular hours, overtime hours, approved time off, gross pay.
4. **Every shift, grouped by workweek** — date, house worked, in, out, recorded meal break, hours, regular, overtime, pay, and how the shift was entered (clocked, typed in, or supervisor override). Each week has its own subtotal, then a period total.
5. **Hours by house** — so I can see when someone covered another house.
6. **Time off** — approved and pending requests that touch the period, plus the PTO balance on file.
7. **Items to review before signing** — a plain list, sorted into "Settle first", "Check" and "Note".
8. **Signature lines** — employee and Program Manager / Supervisor, each with signature, printed name and date.

## What gets flagged
- Clock in/out entries still waiting for approval (those hours are *not* on the sheet yet)
- Someone still clocked in who never clocked out
- Rejected shifts, with the reason (listed, but not counted or paid)
- Clocked shifts with no meal break recorded
- Supervisor overrides
- Shifts of 16 hours or more, and 7 or more days worked in a row
- More than 24 hours in one day (approved exceptions)
- Shifts edited after entry
- Pending time-off requests
- Inactive staff with hours
- **Overtime cross-check** — when hours beyond 40 in a workweek are more than the overtime the system is paying under the 80-hours-per-14-days rule

## Choosing how I want the report
**Report by** — three ways to pick the dates:
- **Pay period** — one whole pay period.
- **Date range** — any From and To dates (up to a year).
- **Single date** — one day only.

**Layout** — two versions of the sheet:
- **Full report** — everything listed above, plus an "at a glance" line (average shift, longest shift, weekend days, overnight shifts, houses worked, days in a row, year to date) and the hire date.
- **Signature copy** — only what the employee needs to sign: their name and the pay period dates in large type, each day's house, time in, time out and hours, the total, and the signature lines. The employee's name is already printed on the "Printed name" line and the dates are printed in the statement they sign.

**Tick boxes** — each one can be changed on either layout:
- **Include pay amounts** — on for the full report, off for the signature copy.
- **Signature lines**
- **Items to review**
- **List every day (show days off)** — shows every date in the range, with "Off" or "Time off" on days with no shift.
- **Add a summary page for all staff** — one page that prints first, with a line per person and a total.
- **Include staff with no hours**

## Where the times come from
Shifts the office types in come from the time log sheets staff fill in to register their time, so the report now calls them **Time log** (it used to say "Manual"). Shifts from the clock in/out buttons say **Clock**, and ones a supervisor clocked for someone say **Override**.

## Getting it out
- **Print** — one staff member per page, letter size. What I see on screen is what prints.
- **PDF** — a real PDF file, one staff member per page, with "page x of y" per person.
- **CSV** — a summary line per person, every shift, and the review items, for Excel.

## Who can see it
Admin, Supervisor and Viewer, the same as the other reports. A custom role needs "View reports". Pay amounts only show for a custom role that also has "View pay rates". Employees do not see this page.

## Three things I fixed along the way
1. **Pay period dates and the clock change.** Period dates were worked out in milliseconds, and a day is not always 24 hours. With my May anchor date, every period label from Oct 24 onward would have shown one day early (for example "Nov 6 – Nov 19" instead of "Nov 7 – Nov 20"). With a winter anchor date it was worse: the first day of each summer period was counted in the previous period, which moves hours between periods and changes overtime. Periods are now counted in calendar days.
2. **"Print Timesheet" printed the whole app.** It printed every page (23 pages in my test) instead of just the Timesheet Log. It now prints only the page I am on.
3. **A brand-new database could not be logged into.** The first admin password from `SEED_ADMIN_PASSWORD` was being scrambled twice, so it never matched. This did not affect my existing database, only a fresh install. The automated tests had also been broken by this; they run again.

## What this does not decide for me
The overtime cross-check only *shows* the difference between "over 40 in a week" and "over 80 in two weeks". It does not change anyone's pay. Which rule ASO must follow is a wage-and-hour question for my payroll provider or an employment attorney, not something the software should settle.

## How I check it still works
```
node test-staff-report.js      (45 checks: pay period dates + report math + layouts)
node test.js                   (117 checks)
node test-meal-breaks.js
node test-tax-brackets.js
node test-payroll-inactive-interaction.js
```
