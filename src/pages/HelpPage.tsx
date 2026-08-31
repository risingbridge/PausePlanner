export default function HelpPage() {
  return (
    <div className="page help-page">
      <h2>Help</h2>
      <p className="hint">
        PausePlanner plans which positions need covering throughout the day and generates a fair schedule of
        who works where. Everything is stored in this browser only — there's no account and no server, so
        data doesn't follow you to a different browser or device unless you export and import it.
      </p>

      <h3>0. The weekly model</h3>
      <p>
        The week is 7 persistent weekday slots — Monday through Sunday — not a calendar. There's no history
        and no dates, just 7 always-present weekdays that repeat every week; editing "Wednesday" always edits
        the same Wednesday. The <strong>day switcher</strong> in the header (Mon–Sun) controls which weekday
        Positions &amp; Openings, Staffing, and Schedule all show — it defaults to today's actual weekday the
        first time you open the app, and remembers your last choice after that. Settings and Help don't change
        with it: the scheduling rules on Settings are shared across every weekday, and Help is static.
      </p>
      <p>
        Positions, openings, staff, day start/end, and the generated schedule are each independent per
        weekday — staff aren't shared across days, and a position named "Reception" on Monday has no
        connection to one named "Reception" on Tuesday beyond sharing a name. To avoid rebuilding a similar
        day from scratch, use <strong>Copy {"<day>"} to...</strong> next to the day switcher: pick one or more
        other weekdays and it copies the current day's positions, openings, staff, and day start/end into
        them (after a confirmation, since it overwrites whatever was there). The generated schedule is never
        copied — copied-to days generate fresh.
      </p>

      <h3>1. Positions &amp; Openings</h3>
      <p>
        Set that day's <strong>day start</strong> and <strong>day end</strong> at the top of the page — this
        defines the whole scheduling window for the currently selected weekday, shown in fixed 15-minute rows.
        Use <strong>Add position</strong> to create each position you need to staff (e.g. "Reception", "TWR").
        For each position, click a cell to toggle it <strong>OPEN</strong> or <strong>CLSD</strong> for that
        time slot — this is when the position needs someone working it. "All open" / "All closed" quickly
        fill an entire column. Rename a position by editing its header, or remove it with the ✕ button.
      </p>

      <h3>2. Staffing</h3>
      <p>
        Add each staff member with their name and shift <strong>start</strong>/<strong>end</strong> time. They
        can only be scheduled into a position during their own shift. Instead of typing custom times, you can
        pick a <strong>shift code</strong> (managed on the Settings page) from the dropdown next to each
        staff member — the times lock to that code's values and stay linked, so editing the code later updates
        everyone using it, on every weekday. Switching back to "Custom" unlinks them, keeping whatever times the
        code last resolved to.
      </p>
      <p>
        Click a staff member's <strong>Blocked times</strong> cell to expand a small editor where you can add
        time windows they're unavailable — meetings, training, anything that takes them off the floor. A
        blocked staff member is never scheduled into a position during that window; the schedule shows it as a
        distinct "MEETING" (or whatever label you give it) cell.
      </p>

      <h3>3. Settings</h3>
      <p>
        The <strong>scheduling algorithm</strong> dropdown at the top picks which algorithm{" "}
        <strong>Generate schedule</strong> uses, shared across every weekday like the rules below.{" "}
        <strong>Quick</strong> is fast and greedy — the default. <strong>Balanced</strong> is slower but sees
        the whole day at once when placing breaks, which can leave fewer positions unstaffed on
        tightly-staffed days. <strong>Thorough</strong> goes further still, deciding breaks and coverage
        together and proving it found the fewest possible unstaffed slots. <strong>Refine</strong> takes a
        different approach — it starts from Quick's schedule and polishes it with thousands of small random
        tweaks, keeping the ones that help; it can't prove its result is the best possible the way Thorough
        can, but it's simple and handles a large roster just as gracefully as a small one. Thorough and Refine
        both run in the background so the page stays responsive, and may take a little longer on a hard day.
        Balanced, Thorough, and Refine never do worse than the faster mode(s) before them.
      </p>
      <p>These numbers control how the schedule is built:</p>
      <ul>
        <li>
          <strong>Minimum position length</strong> — once someone is put into a position, they can't be
          rotated out to rebalance the schedule until they've worked it for at least this long.
        </li>
        <li>
          <strong>Max time in position</strong> — a hard ceiling: nobody continues in the same position past
          this many minutes, no matter what.
        </li>
        <li>
          <strong>Minimum break length</strong> — each person gets exactly <em>one</em> real break during
          their shift, at least this long. It's always guaranteed to happen: a long idle gap already running
          when the target window (below) opens is turned into the break on the spot, and if nothing has
          happened by the end of the window, one is forced right then.
        </li>
        <li>
          <strong>Minimum idle time</strong> — every other time someone is moved off a position (hitting the
          max-time cap again, a position closing, or being rotated out for fairness) is just a short idle
          gap of at least this long — though with no maximum, so it can run longer if no position is
          available.
        </li>
        <li>
          <strong>Earliest break / Latest break</strong> — the target window (as a percentage of each
          person's shift, default 25%–75%) their one real break should land in. If a demand-heavy stretch of
          the day makes it impossible to fit everyone's break in a narrow window without leaving positions
          unstaffed, widening this window (e.g. lowering "earliest break") gives the scheduler more genuinely
          idle time to use, which can resolve those gaps.
        </li>
      </ul>
      <p className="hint">
        These rules are shared across every weekday. Each day's start/end time isn't set here — that lives on
        the Positions &amp; Openings page, since it drives the grid there directly and is independent per day.
      </p>
      <p>
        <strong>Shift codes</strong> are also managed here — named, reusable shift times (e.g. "F1:
        08:00&ndash;15:00") shared across all 7 weekdays. Deleting a code in use doesn't lose anyone's times: any
        staff member still linked to it freezes to its last known start/end and becomes normally editable again.
      </p>
      <p>
        Further down, <strong>Export data</strong> downloads everything — all 7 days' positions, openings,
        staff, blocked times, and generated schedules, plus the shared settings — as a JSON file.{" "}
        <strong>Import data</strong> loads one back in, completely replacing what's currently in the app, so
        you can pick up on another computer or keep a backup before making big changes.
      </p>

      <h3>4. Schedule</h3>
      <p>
        Once you've got positions, openings, and staff set up, click <strong>Generate schedule</strong>. A
        summary table shows each person's total time in position, idle, and on break — it updates
        automatically as you make manual edits. Below that, the result can be viewed two ways:
      </p>
      <ul>
        <li><strong>By position</strong> — who's covering each position at each time.</li>
        <li>
          <strong>By staff</strong> — each person's timeline: which position they're working, when they're on
          their break, idle, blocked, or off shift.
        </li>
      </ul>
      <p>
        A red banner appears if any open position couldn't be staffed at some point — those slots are
        highlighted in the grid too.
      </p>
      <p>
        <strong>Every cell is editable</strong> — click it to open a dropdown and make final manual
        adjustments: reassign who covers a position, or change what a person is doing at that time. Editing
        one cell automatically keeps the rest of the schedule consistent (e.g. reassigning someone frees up
        wherever they were before). Manual edits only exist in the generated result, so clicking
        <strong> Generate schedule</strong> again will discard them.
      </p>
      <p>
        Use <strong>Print / Save as PDF</strong> to print the currently selected day's view, or{" "}
        <strong>Print full week</strong> to print all 7 days in one document using whichever view — by
        position or by staff — you currently have selected, each day on its own page. Any day that hasn't
        been generated yet just shows "Not yet generated" instead of blocking the print.
      </p>

      <h3>Typical workflow</h3>
      <ol>
        <li>Pick a weekday on the day switcher, set its day range, and add your positions on <strong>Positions &amp; Openings</strong>, then mark when each one needs to be staffed.</li>
        <li>Add your staff and their shifts on <strong>Staffing</strong>, plus any meetings or blocked time.</li>
        <li>Tune the shared rules on <strong>Settings</strong> if the defaults don't fit your team.</li>
        <li>Generate the schedule, review both views, and hand-tweak any cells that need a final adjustment.</li>
        <li>Use <strong>Copy to...</strong> to seed similar days instead of rebuilding them from scratch.</li>
        <li>Print each day, or use <strong>Print full week</strong> once all your days are ready.</li>
      </ol>
    </div>
  );
}
