#!/usr/bin/env python3
"""Real bundled-helper IPC gate; isolated files + synthetic runtime/enrollment HTTP server.
Usage: python3 scripts/verify-helper-discovery.py /absolute/path/to/mpai-connector-sidecar
Never invokes a model, the live workspace, Keychain, or the installed application.
"""
import json, os, pathlib, queue, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

root = pathlib.Path(tempfile.mkdtemp(prefix='mpai-helper-discovery-'))
requests = []
class Enrollment(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
        requests.append((self.path, data))
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
        self.wfile.write(json.dumps({'credential_token':'fixture-not-a-real-credential', 'agent_principal_id':'fixture-principal','rooms':[{'id':'fixture-room','name':'Fixture'}]}).encode())
server = ThreadingHTTPServer(('127.0.0.1',0), Enrollment)
threading.Thread(target=server.serve_forever,daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'
class Helper:
    def __init__(self, home, command):
        home.mkdir(exist_ok=True)
        env={'HOME':str(home),'PATH':'/usr/bin:/bin','HERMES_COMMAND':str(command),'MPAI_SUPPORT_DIR':str(home/'support'),'MPAI_IDENTITY_DIR':str(home/'identity')}
        self.process=subprocess.Popen([sys.argv[1]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
        self.messages=queue.Queue();self.sequence=0
        def read():
            for line in self.process.stdout:
                try:self.messages.put(json.loads(line))
                except ValueError:self.messages.put({'protocol_error':True})
        threading.Thread(target=read,daemon=True).start()
    def call(self, command, expect_ok=True, **args):
        self.sequence+=1; request={'id':self.sequence,'command':command,**args}
        self.process.stdin.write((json.dumps(request)+'\n').encode());self.process.stdin.flush()
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            reply=self.messages.get(timeout=max(.01,deadline-time.monotonic()))
            assert 'protocol_error' not in reply,reply
            if reply.get('id')==self.sequence:
                assert reply.get('ok') is expect_ok,reply
                return reply
        raise AssertionError(f'{command} timed out')
    def close(self):
        self.process.terminate()
        try:self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:self.process.kill();self.process.wait()
fixture=root/'fixture-agent'
fixture.write_text('#!/bin/sh\ncase "$1" in\n--version) printf "Hermes Agent v0.20.5\\n";;\nstatus) printf "{\\"running\\":true,\\"controllable\\":true}\\n";;\ngateway) [ "$2" = status ] || exit 1; printf "Gateway running\\n";;\n*) exit 1;;\nesac\n');fixture.chmod(0o755)
checks=[]
try:
    home=root/'fresh'; helper=Helper(home,fixture)
    try:
        assert helper.call('ping')['ok']
        agents=helper.call('detect')['runtimes'];assert len(agents)==1,agents
        agent=agents[0];identity=agent['runtimeInstallationId']
        assert agent['profile']=='default' and agent['runtimeType']=='hermes'
        helper.call('select-runtime',runtimeInstallationId=identity)
        state=helper.call('status')['state'];assert not state['enrolled'] and state['gateway']!='live'
        checks.append('fresh user discovers/selects one runtime without a connection code; not falsely Connected')
        helper.call('configure',baseUrl=base,roomId='fixture-room',agentPrincipalId='fixture-principal',credential='fixture-not-a-real-credential',runtimeSelectionId=identity)
        assert helper.call('status')['state']['gateway']!='live'
    finally:helper.close()
    helper=Helper(home,fixture)
    try:
        agent=helper.call('detect')['runtimes'][0]
        assert agent['runtimeInstallationId']==identity
        helper.call('configure',baseUrl=base,roomId='fixture-room',agentPrincipalId='fixture-principal',credential='fixture-not-a-real-credential',runtimeSelectionId=identity)
        assert helper.call('status')['state']['enrolled']
        checks.append('relaunch restores selected runtime and stable identity with existing credential input')
        # A cancelled/failed enrollment after selecting another profile must never reuse
        # the previously configured machine credential through the new adapter.
        (home/'.hermes'/'profiles'/'named').mkdir(parents=True)
        agents=helper.call('detect')['runtimes']
        named=next(agent for agent in agents if agent['profile']=='named')
        selection_file=home/'support'/'selected-agent.json'
        saved_selection=selection_file.read_bytes()
        state_file=home/'support'/'connector-state.json'
        saved_state=b'{"last_contiguous_seq":17,"pending_actionable_events":[]}'
        state_file.write_bytes(saved_state)
        request_count=len(requests)
        helper.call('select-runtime',runtimeInstallationId=named['runtimeInstallationId'])
        state=helper.call('status')['state']
        assert state['runtime']['profile']=='named' and not state['enrolled'] and not state['running'],state
        for command in ('connect','reconnect'):
            reply=helper.call(command,expect_ok=False)
            assert 'not connected to a workspace' in reply['error'],reply
        # Allow any accidentally scheduled background connection to reach the local server.
        time.sleep(.3)
        assert len(requests)==request_count,requests
        assert selection_file.read_bytes()==saved_selection
        assert state_file.read_bytes()==saved_state
        # Configure explicitly restores the saved identity, even while another adapter
        # is selected. Credentials are supplied again, never recovered from that adapter.
        helper.call('configure',baseUrl=base,roomId='fixture-room',agentPrincipalId='fixture-principal',credential='fixture-not-a-real-credential',runtimeSelectionId=identity)
        state=helper.call('status')['state']
        assert state['enrolled'] and state['runtime']['runtimeInstallationId']==identity,state
        assert state['runtime']['profile']=='default' and not state['running'],state
        assert selection_file.read_bytes()==saved_selection
        assert state_file.read_bytes()==saved_state
        helper.call('select-runtime',runtimeInstallationId=identity)
        assert helper.call('status')['state']['enrolled'], 'same selection must retain its configuration'
        checks.append('profile switch fences connect/reconnect without network or durable-state loss; explicit configure restores saved identity')
        helper.call('select-runtime',runtimeInstallationId=named['runtimeInstallationId'])
        helper.call('configure',baseUrl=base,roomId='fixture-room',agentPrincipalId='fixture-principal',credential='fixture-not-a-real-credential')
        legacy=helper.call('status')['state']
        assert legacy['runtime']['runtimeInstallationId']==identity and legacy['runtime']['profile']=='default',legacy
        assert legacy['enrolled'] and not legacy['running'],legacy
        checks.append('legacy enrollment without selection metadata restores default, never a tentative named profile')
        result=helper.call('enroll',baseUrl=base,code='fixture-one-time-code',deviceLabel='Test Mac')
        assert result['enrollment']['agent_principal_id']=='fixture-principal'
        assert requests[-1] == ('/v1/agent-gateway/v1/enroll', {'code':'FIXTURE-ONE-TIME-CODE', 'device_label':'Test Mac'}),requests
        checks.append('Advanced manual code enrollment fallback reaches the enrollment endpoint')
    finally:helper.close()
    helper=Helper(root/'missing',root/'absent-agent')
    try:
        assert helper.call('detect')['runtimes']==[]
        assert helper.call('ping')['ok']
        checks.append('no-agent-found is empty discovery, not helper failure; IPC remains responsive')
    finally:helper.close()
    print(json.dumps({'passed':checks,'evidence_root':str(root)},indent=2))
finally:server.shutdown();server.server_close()
