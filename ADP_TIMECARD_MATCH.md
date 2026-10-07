# ADP Timecard Match — what I built and how I use it

## What it does
I upload the Timecard Report PDF from ADP. The system reads every punch, matches each person to the timesheet, and sorts every difference by what it needs. Nothing that changes pay happens until a person confirms it.

I find it in the left menu under **ADP Timecard Match** (Admin and Supervisor only).

## How the system sorts each difference
| Class | What it means | What the system does |
|---|---|---|
| **Match** | ADP and the timesheet agree exactly | Nothing |
| **Ready to apply** | Times differ by a few minutes (15 or less, which I can change) | Already ticked. One click on Apply sets the timesheet to the ADP punch |
| **Suggested — confirm** | Punched in ADP, nothing on the timesheet | Proposes the shift and suggests the house from where that person usually works that day. I confirm or change the house, then apply |
| **Needs review** | Times differ by more than the limit, or the shift was rebuilt from punch errors | Never ticked for me. I decide each one |
| **Needs punch correction** | On the timesheet, no ADP punch | The shift stays and is paid as entered. I get the punch fixed in ADP. I only tick it if the shift was not worked, and then it is rejected, not deleted |
| **ADP punch error** | In and out at the same minute, 0:00 paid | Information only. If there are two on one day, the system rebuilds the likely shift and sends it to Needs review |

## Each week, step by step
1. Enter the signed time log sheets on the Timesheet Log.
2. In ADP, run the Timecard Report for the same dates and save it as a PDF.
3. On ADP Timecard Match, press **Choose file** and pick the PDF.
4. Read the box **Who is on one record but not the other** and explain anyone listed.
5. If ADP names are not recognised, pick who each one is (remembered on that computer), or mark them "leave out".
6. Press **Apply** for the Ready items.
7. Check the houses on the Suggested items, tick them, and apply.
8. For each Needs review item, either tick and apply it, or press **Mark reviewed — no change** and type the reason.
9. Fix missed and bad punches in ADP, then upload the file again. Fixed items become matches.
10. When the banner says nothing is open, press **Sign off this week**.
11. Press **Print report** and file the Reconciliation Report with payroll.

## What I see while I work
- **Pay effect**: for each person and in total, what applying everything proposed would do to pay and to overtime. It uses the same overtime calculation as payroll.
- **Still open**: how many items are left before I can sign off.
- **Suggested house**: with the reason, for example "worked there 3 of the last 4 Thursdays". I can change it.

## The Reconciliation Report
One report per upload, with the logo, that I can print or save as PDF:
1. Summary — staff compared, hours on each side, the difference, pay effect, and a count of each class
2. Who is on one record but not the other
3. By person
4. By house
5. Every difference, with what is recommended or what was decided
6. Corrections made, taken from the Audit Trail (who, when, old and new time)
7. Habits worth a conversation — missed punches, early punch-ins, late punch-outs
8. Decisions that belong to management
9. Sign-off

The **CSV** has the same information for Excel.

## The procedure page
The **Procedure** button prints a one-page weekly procedure for Program Managers and payroll. It is marked "Draft for management approval" because it contains rules I need to confirm before I hand it out.

## Safety rules built in
- Nothing changes until I tick rows and confirm.
- A locked pay period cannot be changed from here.
- A correction that would overlap another shift is skipped, and I am told why.
- A shift is never rejected on a day where ADP has a punch error.
- Nothing is deleted.
- Every correction, every "reviewed — no change", every sign-off and every reopen is in the Audit Trail with a name and a time.
- A signed-off week is closed on this page. Only an admin can reopen it, with a reason.
- The ADP file is read on my computer only. It is not uploaded or stored.

## Things to know
- Sign-off closes the week on this page. It does not lock the Timesheet Log itself; confirming payroll does that.
- "Habits" come from the one file I uploaded, not from history.
- It reads the ADP Timecard Report PDF layout. A different ADP report would need its own reader.
- ADP's own overtime figure is shown for information. Overtime here is still worked out by this system's rule.

## What this does not decide for me
These are my decisions as the employer, and I should confirm them with my payroll provider or an employment attorney:
- Which record is the record of time worked when ADP and the time log sheet disagree.
- Whether a signed correction form is required for a missed punch.
- Which overtime rule applies. ADP calculates weekly overtime; this system pays overtime after 80 hours in 14 days.
- How long the reports are kept.

## How I check it still works
```
node test-adp-match.js         (68 checks)
node test-staff-report.js      (45 checks)
node test.js                   (117 checks)
```
