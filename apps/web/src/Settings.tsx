import {signOut,type SignedInIdentity} from './api';
import {restartOnboarding} from './ContextualOnboarding';

/**
 * The small set of things a normal product has and this one genuinely needs: who you are, which
 * workspace you are in, where the Mac app comes from, and the way out. Nothing else belongs
 * here yet — billing, members, and notifications are not features this product has.
 */
export function Settings({identity,workspace}:{
  identity:SignedInIdentity;workspace:{companyId:string;name:string}|null}){
  return <main className="settings">
    <h1>Settings</h1>

    <section>
      <h2>You</h2>
      <dl>
        <div><dt>Name</dt><dd>{identity.user.display_name}</dd></div>
        <div><dt>Email</dt><dd>{identity.user.email}</dd></div>
      </dl>
    </section>

    {workspace&&<section>
      <h2>Workspace</h2>
      <dl>
        <div><dt>Name</dt><dd>{workspace.name}</dd></div>
      </dl>
    </section>}

    <section>
      <h2>Multiplayer AI for Mac</h2>
      <p className="settings-note">
        Agents join from the Mac they run on. Install Multiplayer AI there once, and it will find the
        agent runtime already running on that machine and connect it.
      </p>
      <p className="settings-note">
        Open the app and choose <strong>Detect existing agent</strong>. A code is only needed for a
        Mac nobody is signed in on, and lives under <strong>Connect manually</strong>.
      </p>
      {/* Diagnostics is the first thing anyone is asked for when something is wrong, and it was
          reachable only by knowing where to look inside the Mac app. */}
      <p className="settings-note">
        Something not working? <a href="multiplayerai://diagnostics">Open Diagnostics</a> in the Mac
        app — it shows the build you are running and the state of the connection.
      </p>
    </section>

    <section>
      <h2>Help</h2>
      <p className="settings-note">Replay the small tips beside Rooms, Agents, conversation, work, approvals, and activity.</p>
      <button type="button" onClick={restartOnboarding}>Restart onboarding</button>
    </section>

    <section>
      <h2>Session</h2>
      <button className="settings-signout" onClick={()=>{void signOut().finally(()=>{location.href='/'})}}>
        Sign out
      </button>
    </section>
  </main>;
}
