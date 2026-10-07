# ADP Timecard Match — what I built and how to use it

## What it does
I upload the Timecard Report PDF from ADP and the system does the matching for me:

1. It reads every employee and every punch in the file.
2. It matches each ADP name to the staff member in the Time System.
3. It lines up each punch with the shift on the Timesheet Log for the same day.
4. It shows me the differences.
5. For the rows I tick, it corrects the timesheet to the ADP punch time, so payroll runs on the actual time.

I find it in the left menu under **ADP Timecard Match** (Admin and Supervisor only).

## Step by step
1. In ADP, run the **Timecard Report** for the dates I want and save it as a PDF.
2. On the ADP Timecard Match page, press **Choose file** and pick that PDF.
3. If any ADP names are not recognised, a list appears. I pick who each one is, once. The system remembers my choice on that computer. I can also mark a name "Not in this system — leave out".
4. I read the box called **Who is on one record but not the other**. It has two lists:
   - **On the ADP timecard, nothing on the timesheet** — people who punched in ADP but have no shifts on the timesheet for those dates. This includes ADP names that are not staff members in the Time System at all.
   - **On the timesheet, not on the ADP timecard** — people with timesheet hours who have no ADP punches in the file.
   Each list shows a count, and says "Nobody" when it is clear. Both lists are also at the top of the CSV.
5. I read the numbers at the top: staff compared, punches that match, time differs, in ADP but not on the timesheet, on the timesheet but not in ADP, and the hour difference.
6. I tick what I want corrected. There are buttons to tick a whole group at once.
7. I press **Apply corrections**, read the summary, and confirm.

## What each result means
| Result | What it means | What applying does |
|---|---|---|
| **Match** | In and out agree within the minutes I chose (7 by default) | Nothing needed |
| **Time differs** | Same shift, different times | Changes the timesheet shift to the ADP in and out |
| **Not on timesheet** | ADP has a punch, the timesheet has no shift | Adds a shift at the person's home house, marked "ADP" |
| **Not in ADP** | The timesheet has a shift, ADP has no punch | Rejects the shift (it stays visible with the reason; it is not deleted) |
| **ADP punch error** | In and out at the same minute, 0:00 paid | Nothing. I fix it in ADP and upload again |

## Safety rules built in
- Nothing changes until I tick rows and confirm.
- A locked pay period (payroll already confirmed) cannot be changed from here.
- A correction that would overlap another shift is skipped, and I am told which one and why.
- On a day where ADP has a punch error, the timesheet shift cannot be rejected from here, because it was probably worked.
- Nothing is ever deleted.
- Every change is written to the Audit Trail as "ADP Correction", with the old time, the new time and the file name.
- The ADP file is read on my computer only. It is not uploaded or stored.

## Things to know
- A shift added from ADP goes under the person's **home house**, because ADP only knows the department, not the house. If they covered another house, I change the house on the Timesheet Log.
- The Staff Timesheet Report shows a note on any shift that was corrected from ADP, with what the time log sheet originally said.
- ADP's own overtime figure is shown for information. Overtime in this system is still worked out by its own rule.
- It reads the ADP "Timecard Report" PDF layout. A different ADP report or a spreadsheet export would need its own reader.

## What this does not decide for me
The system makes the timesheet agree with ADP. Whether the ADP punch or the signed time log sheet is the "actual" time when they disagree is my decision as the employer, row by row. In general an employer has to pay for all time actually worked, so I should be careful before choosing the shorter of the two. That is a wage-and-hour question for my payroll provider or an employment attorney, not something the software settles.

## The logo
The company logo is now on every Staff Timesheet Report sheet, in the PDF, and at the top of every other page I print from the system. It is built into the main file, so there is no separate image to deploy.

## How I check it still works
```
node test-adp-match.js         (36 checks: reading the timecard, matching names, comparing punches)
node test-staff-report.js      (45 checks)
node test.js                   (117 checks)
```
