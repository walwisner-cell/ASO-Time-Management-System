# ADP Timecard Match — what I built and how I use it

## What it does
I upload the Timecard Report PDF from ADP. The system takes every shift on the timesheet, finds the ADP punch that covers that shift period, and compares the hours. It then shows me an audit with six tabs — the same six tabs as my Excel audit workbook — and lets me download that workbook.

Nothing that changes pay happens until a person confirms it.

I find it in the left menu under **ADP Timecard Match** (Admin and Supervisor only).

## How a punch is matched to a shift
- A punch belongs to a shift when the two cover the same stretch of time: at least 30 minutes in common, and at least a quarter of the shorter one. A morning punch is not matched to an afternoon shift just because they touch.
- Overnight shifts are handled. A 10 PM – 6 AM shift is matched to the 10 PM – 6 AM punch, not to a day punch on the same date.
- Two punches one straight after the other (30 minutes or less between them) that cover one shift are joined and counted as one stretch.
- The result is decided on **hours**, not on clock times. Someone who punches in 19 minutes late and out 14 minutes late has the same hours and is a match.

## The four results for a timesheet shift
| Result | What it means |
|---|---|
| **Match** | ADP hours and timesheet hours are within the tolerance (15 minutes unless I change it) |
| **Hours differ** | There is a punch for the shift, but the hours are further apart than the tolerance |
| **No ADP punch** | The shift is on the timesheet and ADP has nothing for it |
| **Incomplete ADP punch** | The only punch is unusable: in and out at the same minute, a few minutes long, or no out time |

Two more for punches:
| Result | What it means |
|---|---|
| **ADP, not on timesheet** | A real punch with no timesheet shift |
| **Stray ADP punch** | A zero-length punch with no shift near it |

## The audit (the first thing I see after uploading)
| Tab | What is on it |
|---|---|
| **Summary** | The tolerance, how many shifts were checked, the count of each result, hours with no usable punch, punches with no shift, staff with no ADP card, staff over 40 hours |
| **Shift Match** | One line per timesheet shift: staff, date, house, timesheet in/out/hours, ADP in/out/hours, the difference, the result, and "What I found" in plain words |
| **ADP Not On Timesheet** | Every punch with no timesheet shift, and who the timesheet has at that person's house at that time |
| **ADP Punches** | Every punch read from the file, and whether it was matched |
| **Staff Totals** | Per person: timesheet hours, ADP hours, the difference, the higher of the two, and hours over 40 |
| **Timesheet Checks** | Problems on the timesheet itself (see below) |

**Download Excel audit** saves the workbook as `ASO_Time_Audit_<from>_to_<to>.xlsx`. It has the same six tabs. The Result column is a formula, so if I change the tolerance on the Summary tab in Excel, the results and counts recalculate. Rows are coloured green, yellow and red the same way as my workbook.

## Timesheet Checks
These need no ADP file to be true — they are about the timesheet:
- **Overlapping shifts** — one person in two places at the same time.
- **Over 40 hours in the week, OT shows 0.00** — more than 40 timesheet hours and no overtime on the timesheet.
- **Shift over 16 hours** — one entry longer than 16 hours.
- **Back-to-back shifts** — entries that run straight into each other for 16 hours or more.
- **Coverage gap on timesheet** — a house that is staffed round the clock with an hour or more where nobody is listed. If ADP shows someone working then, it names them.
- **House/day with no entries** — a whole day with nothing entered for a round-the-clock house.
- **House missing from timesheet** — a house with no timesheet entries at all, while its staff have ADP punches.

Notes on coverage: a house counts as round-the-clock when the timesheet covers at least 60% of the hours in the dates. On the first morning, the system assumes the usual overnight ran until 6 AM unless the day before is on the timesheet, in which case it uses that.

## Each week, step by step
1. Enter the signed time log sheets on the Timesheet Log.
2. In ADP, run the Timecard Report for the same dates and save it as a PDF.
3. On ADP Timecard Match, press **Choose file** and pick the PDF.
4. If ADP names are not recognised, open the **Worklist** and pick who each one is (remembered on that computer), or mark them "leave out".
5. Read the audit tabs. Press **Download Excel audit** for the file.
6. Fix anything on **Timesheet Checks** that is a data-entry mistake on the Timesheet Log, then upload the PDF again.
7. On the **Worklist**, for each **Hours differ** line: tick it and apply to set the shift to the ADP punch, or mark it reviewed with the reason.
8. For each **ADP, not on timesheet** line: check the house, tick it and apply to add the shift — or mark it reviewed with the reason.
9. For **No ADP punch** and **Incomplete ADP punch**: get the punch fixed in ADP and upload again, or mark them reviewed with the reason ("paid from the signed time log sheet"). **Mark all N reviewed** does one person's lines in one go.
10. When the banner says nothing is open, press **Sign off**.
11. Press **Print report** and file the Reconciliation Report with payroll.

## Settings on the page
- **Match when hours are within** — 5, 10, 15 or 30 minutes. 15 is what my workbook uses.
- **House** — everything on the page for one house only (see below).
- **Don't audit office (Admin) punches** — ADP Administrative staff with no timesheet shift are listed on the ADP Punches tab only, because office hours are not on the timesheet. Untick it to audit them too.
- **Hide matches on the worklist** — shows only lines that need something.

## Doing it one house at a time
After I upload the file, I pick a house in the **House** dropdown. The audit, the worklist, the report, the Excel file and the CSV then cover that house only.

- A line belongs to the house where the shift was worked. A punch with no timesheet shift belongs to the house the system suggests (I can change it).
- Someone who worked at two houses shows up under each house, with only that house's shifts.
- When a house has nothing open, the Program Manager for that house signs it off, and the other houses stay open.
- ADP names not matched to a staff member have no house. I switch to **All houses** to match them.

## The Reconciliation Report
A printable report with the logo: summary, who is on one record but not the other, by person, by house, every difference with what was decided, corrections made (from the Audit Trail), habits worth a conversation, decisions that belong to management, and sign-off.

## Safety rules built in
- Nothing changes until I tick rows and confirm.
- A locked pay period cannot be changed from here.
- A correction that would overlap another shift is skipped, and I am told why.
- Nothing is deleted. A shift that was not worked is rejected with a reason and stays visible.
- Every correction, every "reviewed — no change", every sign-off and every reopen is in the Audit Trail with a name and a time.
- A signed-off week is closed on this page. Only an admin can reopen it, with a reason.
- The ADP file is read on my computer only. It is not uploaded or stored.

## Things to know
- The Excel download and the PDF reader are loaded from the internet (cdnjs) the first time I use them, so the computer needs to be online.
- It reads the ADP Timecard Report PDF layout. A different ADP report would need its own reader.
- "Hours over 40" on Staff Totals is a flag for me to look at. It is not what the system pays as overtime.
- Sign-off closes the week on this page. It does not lock the Timesheet Log itself; confirming payroll does that.
- When ADP spells a name slightly differently (same last name, same first initial), the system treats it as the same person and says so on the Summary tab so I can confirm.

## What this does not decide for me
These are my decisions as the employer, and I should confirm them with my payroll provider or an employment attorney:
- Which record is the record of time worked when ADP and the time log sheet disagree.
- Whether a signed correction form is required for a missed punch.
- Which overtime rule applies. ADP calculates weekly overtime; this system pays overtime after 80 hours in 14 days. The "over 40 hours, OT shows 0.00" check exists because of this difference.
- How long the reports are kept.

## How I check it still works
```
node test-adp-match.js         (95 checks)
node test-staff-report.js      (63 checks)
node test.js                   (117 checks)
```
