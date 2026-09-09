export default function PrivacyPage() {
  return (
    <div className="page help-page">
      <h2>Privacy &amp; Data</h2>
      <p className="hint">
        PausePlanner has no backend, no account, and no server it talks to — everything described here follows
        from that.
      </p>

      <h3>Where your data lives</h3>
      <p>
        Every position, opening, staff member, blocked time, requirement, generated schedule, and setting you
        enter is stored only in your browser's <strong>localStorage</strong>, under the key{" "}
        <code>pauseplanner_state_v2</code>. Nothing is sent anywhere — there's no server for it to go to. That
        also means your data is tied to one browser on one device: it won't appear if you open the app in a
        different browser, in a private/incognito window, or on another computer, and clearing your browser's
        site data for this app deletes it for good.
      </p>
      <p>
        Use <strong>Export data</strong> on the Settings page any time to download everything as a JSON file —
        useful as a backup, or to move your data to another browser or device via <strong>Import data</strong>.
        The exported file is just as private as the app itself: it's saved to your own computer, not uploaded
        anywhere.
      </p>

      <h3>Cookies and tracking</h3>
      <p>
        PausePlanner sets no cookies, runs no analytics, and includes no third-party trackers, fonts, or
        scripts of any kind. The only dependency loaded at runtime beyond the app itself is the optimization
        solver used by the <strong>MIP (HiGHS)</strong> scheduling algorithm — a ~3.4MB file bundled with the
        app and loaded from the same origin, not fetched from an external service.
      </p>
      <p>
        The app is hosted as a static site on GitHub Pages. Like any web host, GitHub's servers see the
        ordinary technical details of a page request (IP address, browser user agent, timestamp) in their own
        access logs — the same as any website you visit — but that's GitHub's infrastructure, not something
        PausePlanner adds, reads, or has access to.
      </p>

      <h3>Clearing your data</h3>
      <p>
        Settings → <strong>Danger zone</strong> has a button to erase everything and start fresh. It resets
        the app's own stored state; if you ever used a version of PausePlanner from before the current 7-day
        weekly model, a one-time migration backup of that old data may still sit untouched in your browser's
        storage under a separate key. If you want every trace of PausePlanner gone from a browser, clearing
        that site's data from your browser's own settings removes all of it, backup included.
      </p>

      <h3>In short</h3>
      <ul>
        <li>No account, no sign-in, nothing to leak from a server — because there isn't one.</li>
        <li>Your data stays on your device, in your browser, until you export it or clear it yourself.</li>
        <li>No cookies, no analytics, no third-party tracking.</li>
        <li>You're always one click away from a full export or a full erase, both on the Settings page.</li>
      </ul>
    </div>
  );
}
