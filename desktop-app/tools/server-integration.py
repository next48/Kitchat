"""Run only against the disposable MySQL service in CI, never a live KitChat DB."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

assert os.environ.get('KITCHAT_TEST_DATABASE') == 'isolated_ci_only'
root = Path(__file__).resolve().parents[1]
tokens = ['a' * 48, 'b' * 48, 'c' * 48]
with tempfile.TemporaryDirectory() as directory:
    public = Path(directory)
    (public / 'api').mkdir()
    (public / 'bd').mkdir()
    for filename in ['direct_messages.php', 'call_signal.php']:
        shutil.copy(root / 'server-update/api' / filename, public / 'api' / filename)
    shutil.copy(root.parent / 'bd/desktop_session.php', public / 'bd/desktop_session.php')
    (public / 'bd/database.php').write_text("<?php $link = new mysqli('127.0.0.1','root',getenv('MYSQL_TEST_PASSWORD'),'kit_test');", encoding='utf-8')
    (public / 'bd/onesignal.php').write_text('<?php function finish_response_before_push() {} function send_chat_push(...$args) {}', encoding='utf-8')
    sessions = ','.join(f"('{hashlib.sha256(token.encode()).hexdigest()}',{i+1},DATE_ADD(NOW(),INTERVAL 1 DAY))" for i, token in enumerate(tokens))
    setup = f"""<?php
    require '{public.as_posix()}/bd/database.php';
    $link->query('CREATE TABLE user (id INT PRIMARY KEY,name VARCHAR(80),login VARCHAR(80))');
    $link->query(\"INSERT INTO user VALUES (1,'Alice','alice'),(2,'Bob','bob'),(3,'Other','other')\");
    $link->query('CREATE TABLE friends (user_id INT,friend_id INT,status INT)');
    $link->query('INSERT INTO friends VALUES (1,2,1)');
    require '{public.as_posix()}/bd/desktop_session.php';
    desktop_session_prepare($link);
    $link->query(\"INSERT INTO desktop_sessions(token_hash,user_id,expires_at) VALUES {sessions}\");
    """
    subprocess.run(['php'], input=setup.encode(), check=True)
    server = subprocess.Popen(['php', '-S', '127.0.0.1:8123', '-t', str(public)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    def request(endpoint, user=1, query=None, data=None, expected=200):
        url = f'http://127.0.0.1:8123/api/{endpoint}.php?' + urlencode(query or {})
        req = Request(url, data=urlencode(data).encode() if data is not None else None,
                      headers={'Authorization': 'Bearer ' + tokens[user-1], 'Content-Type': 'application/x-www-form-urlencoded'})
        try:
            response = urlopen(req, timeout=5)
        except HTTPError as error:
            response = error
        assert response.status == expected, (endpoint, response.status, expected, response.read())
        return json.loads(response.read())
    try:
        for attempt in range(30):
            try:
                request('direct_messages', query={'action': 'list'})
                break
            except OSError:
                time.sleep(.1)
        sent = request('direct_messages', data={'action':'send','user_id':2,'message':'original'})
        message_id = sent['message']['id']
        request('direct_messages', 2, data={'action':'edit','id':message_id,'message':'forged'}, expected=403)
        request('direct_messages', data={'action':'edit','id':message_id,'message':'updated'})
        thread = request('direct_messages', 2, query={'action':'thread','user_id':1})
        assert thread['messages'][0]['message'] == 'updated'
        request('direct_messages', 2, data={'action':'delete','id':message_id}, expected=403)
        request('direct_messages', data={'action':'delete','id':message_id})
        assert not request('direct_messages', 2, query={'action':'thread','user_id':1})['messages']
        request('direct_messages', 3, data={'action':'send','user_id':1,'message':'blocked'}, expected=403)
        def signal(user, peer, kind, call_id='00000000-0000-4000-8000-000000000001'):
            return request('call_signal', user, data={'target_id':peer,'signal':json.dumps({'kind':kind,'call_id':call_id,'name':'forged','description':{'type':kind,'sdp':'test'}})})
        offer = signal(1,2,'offer')
        pending = request('call_signal', 2, query={'pending':1})['pending']
        assert pending['sender_id'] == 1 and pending['signal_id'] == offer['id']
        received = request('call_signal', 2, query={'peer_id':1,'after_id':0})['signals']
        assert received[-1]['signal']['name'] == 'Alice'
        request('call_signal', 3, data={'target_id':1,'signal':json.dumps({'kind':'offer'})}, expected=403)
        answer = signal(2,1,'answer')
        assert request('call_signal', 2, query={'pending':1})['pending'] is None
        assert request('call_signal', 1, query={'peer_id':2,'after_id':0})['signals'][-1]['signal']['kind'] == 'answer'
        signal(1,2,'hangup')
        assert request('call_signal', 2, query={'pending':1})['pending'] is None
        print('PASS: two isolated accounts send/edit/delete with ownership checks; offer/answer/hangup; friend access; server caller identity')
    finally:
        server.terminate()
        server.wait(timeout=5)
