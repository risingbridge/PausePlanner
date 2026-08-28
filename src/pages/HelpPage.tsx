export default function HelpPage() {
  return (
    <div className="page help-page">
      <h2>Help</h2>
      <p className="hint">
        PausePlanner plans which positions need covering throughout the day and generates a fair schedule of
        who works where. Everything is stored in this browser only — there's no account and no server, so
        data doesn't follow you to a different browser or device unless you export and import it.
      </p>

      <h3>1. Positions &amp; Openings</h3>
      <p>
        Set the <strong>day start</strong> and <strong>day end</strong> at the top of the page — this defines
        the whole scheduling window, shown in fixed 15-minute rows. Use <strong>Add position</strong> to
        create each position you need to staff (e.g. "Reception", "TWR"). For each position, click a cell to
        toggle it <strong>OPEN</strong> or <strong>CLSD</strong> for that time slot — this is when the position
        needs someone working it. "All open" / "All closed" quickly fill an entire column. Rename a position
        by editing its header, or remove it with the ✕ button.
      </p>

      <h3>2. Staffing</h3>
      <p>
        Add each staff member with their name and shift <strong>start</strong>/<strong>end</strong> time. They
        can only be scheduled into a position during their own shift.
      </p>
      <p>
        Click a staff member's <strong>Blocked times</strong> cell to expand a small editor where you can add
        time windows they're unavailable — meetings, training, anything that takes them off the floor. A
        blocked staff member is never scheduled into a position during that window; the schedule shows it as a
        distinct "MEETING" (or whatever label you give it) cell.
      </p>

      <h3>3. Settings</h3>
      <p>These four numbers control how the schedule is built:</p>
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
          their shift, at least this long. It's placed at the first natural opportunity at or after the
          middle of their shift, but is always guaranteed to happen even if nothing else would have stopped
          them (forced near the end of the shift as a last resort).
        </li>
        <li>
          <strong>Minimum idle time</strong> — every other time someone is moved off a position (hitting the
          max-time cap again, a position closing, or being rotated out for fairness) is just a short idle
          gap of at least this long, not a full break.
        </li>
      </ul>
      <p className="hint">
        The day's start/end time isn't set here — that lives on the Positions &amp; Openings page, since it
        drives the grid there directly.
      </p>
      <p>
        Further down, <strong>Export data</strong> downloads everything — positions, openings, staff, blocked
        times, settings, and the generated schedule — as a JSON file. <strong>Import data</strong> loads one
        back in, completely replacing what's currently in the app, so you can pick up on another computer or
        keep a backup before making big changes.
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
      <p>Use <strong>Print / Save as PDF</strong> to print the current view or save it as a PDF via your browser's print dialog.</p>

      <h3>Typical workflow</h3>
      <ol>
        <li>Set the day range and add your positions on <strong>Positions &amp; Openings</strong>, then mark when each one needs to be staffed.</li>
        <li>Add your staff and their shifts on <strong>Staffing</strong>, plus any meetings or blocked time.</li>
        <li>Tune the rules on <strong>Settings</strong> if the defaults don't fit your team.</li>
        <li>Generate the schedule, review both views, and hand-tweak any cells that need a final adjustment.</li>
        <li>Print or save it as a PDF to share.</li>
      </ol>
    </div>
  );
}
