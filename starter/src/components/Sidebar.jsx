import asset from '../lib/assetUrl';

/** Left panel shell: title, description, and the link to the Audiom explorer. */
export function Sidebar({ children }) {
  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <div>
          <p className="eyebrow">Open Source Assistive Technology Hackathon</p>
          <h1>Tactile Map Explorer</h1>
        </div>
        <p className="subtle">
          Generate a tactile pin grid from the map, then explore it by camera or audio.
        </p>
        <a className="sidebar-link" href={asset('audiom.html')}>
          Switch to Tactile Audiom Explorer →
        </a>
      </header>
      {children}
    </aside>
  );
}

export default Sidebar;
