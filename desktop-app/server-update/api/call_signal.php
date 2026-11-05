<?php
require_once __DIR__ . '/../bd/database.php';
require_once __DIR__ . '/../bd/onesignal.php';
require_once __DIR__ . '/../bd/desktop_session.php';
desktop_cors();

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$user_id = desktop_bearer_token() !== '' ? desktop_session_user($link) : (isset($_COOKIE['id']) ? (int)$_COOKIE['id'] : 0);
if ($user_id <= 0) {
    http_response_code(401);
    echo json_encode(['ok' => false, 'error' => 'auth']);
    exit;
}

@mysqli_set_charset($link, 'utf8mb4');
@mysqli_query($link, "CREATE TABLE IF NOT EXISTS call_signals (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sender_id INT NOT NULL,
    receiver_id INT NOT NULL,
    signal_json TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY receiver_sender_id (receiver_id, sender_id, id),
    KEY created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
@mysqli_query($link, "DELETE FROM call_signals WHERE created_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)");

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $target_id = isset($_POST['target_id']) ? (int)$_POST['target_id'] : 0;
    $signal_raw = isset($_POST['signal']) ? (string)$_POST['signal'] : '';
    $signal = json_decode($signal_raw, true);
    $allowed = ['offer', 'answer', 'ice', 'hangup', 'decline', 'busy'];
    if ($target_id <= 0 || $target_id === $user_id || !is_array($signal)
        || empty($signal['kind']) || !in_array($signal['kind'], $allowed, true)
        || strlen($signal_raw) > 20000) {
        http_response_code(422);
        echo json_encode(['ok' => false, 'error' => 'invalid']);
        exit;
    }

    $exists = @mysqli_query($link, "SELECT id FROM user WHERE id=$target_id LIMIT 1");
    if (!$exists || !mysqli_fetch_assoc($exists)) {
        http_response_code(404);
        echo json_encode(['ok' => false, 'error' => 'user']);
        exit;
    }

    $friend = mysqli_query($link,"SELECT 1 FROM friends WHERE status=1 AND ((user_id=$user_id AND friend_id=$target_id) OR (user_id=$target_id AND friend_id=$user_id)) LIMIT 1");
    if (!$friend || !mysqli_fetch_row($friend)) { http_response_code(403); echo json_encode(['ok'=>false,'error'=>'Звонки доступны только друзьям']); exit; }
    if ($signal['kind']==='offer') {
        $caller=mysqli_query($link,"SELECT name FROM user WHERE id=$user_id LIMIT 1");
        $signal['name']=(string)(mysqli_fetch_assoc($caller)['name'] ?? 'KitChat');
        $signal_raw=json_encode($signal,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
    }
    $stmt = mysqli_prepare($link, "INSERT INTO call_signals(sender_id,receiver_id,signal_json) VALUES(?,?,?)");
    mysqli_stmt_bind_param($stmt, 'iis', $user_id, $target_id, $signal_raw);
    $ok = mysqli_stmt_execute($stmt);
    if ($ok && in_array($signal['kind'], ['answer', 'decline', 'busy'], true)) {
        @mysqli_query($link, "DELETE FROM call_signals
            WHERE sender_id=$target_id AND receiver_id=$user_id
              AND signal_json LIKE '%\"kind\":\"offer\"%'");
    }
    echo json_encode(['ok' => (bool)$ok, 'id' => $ok ? (int)mysqli_insert_id($link) : 0]);
    if ($ok && $signal['kind'] === 'offer') {
        finish_response_before_push();
        send_chat_push($link, $target_id, 'Входящий звонок — нажмите, чтобы ответить', 'call');
    }
    exit;
}

$pending = !empty($_GET['pending']);
if ($pending) {
    $ended = [];
    $pending_call = null;
    $pending_result = @mysqli_query($link, "SELECT id,sender_id,receiver_id,signal_json FROM call_signals
        WHERE (receiver_id=$user_id OR sender_id=$user_id) AND created_at >= DATE_SUB(NOW(), INTERVAL 45 SECOND)
        ORDER BY id DESC LIMIT 100");
    if ($pending_result) while ($row = mysqli_fetch_assoc($pending_result)) {
        $sender = (int)$row['sender_id'];
        $outgoing = $sender === $user_id;
        $peer = $outgoing ? (int)$row['receiver_id'] : $sender;
        $decoded = json_decode($row['signal_json'], true);
        $kind = is_array($decoded) && isset($decoded['kind']) ? $decoded['kind'] : '';
        if (in_array($kind, ['hangup', 'decline', 'busy', 'answer'], true)) {
            $ended[$peer] = true;
        } elseif ($kind === 'offer' && !$outgoing && empty($ended[$sender])) {
            $pending_call = ['sender_id' => $sender, 'signal_id' => (int)$row['id']];
            break;
        }
    }
    echo json_encode(['ok' => true, 'pending' => $pending_call]);
    exit;
}

$peer_id = isset($_GET['peer_id']) ? (int)$_GET['peer_id'] : 0;
$after_id = isset($_GET['after_id']) ? max(0, (int)$_GET['after_id']) : 0;
$signals = [];
$last_id = $after_id;
if ($peer_id > 0) {
    $result = @mysqli_query($link, "SELECT id,sender_id,signal_json FROM call_signals
        WHERE receiver_id=$user_id AND sender_id=$peer_id AND id>$after_id
          AND created_at >= DATE_SUB(NOW(), INTERVAL 2 MINUTE)
        ORDER BY id ASC LIMIT 100");
    if ($result) while ($row = mysqli_fetch_assoc($result)) {
        $last_id = max($last_id, (int)$row['id']);
        $decoded = json_decode($row['signal_json'], true);
        if (is_array($decoded)) $signals[] = [
            'id' => (int)$row['id'],
            'fromId' => (int)$row['sender_id'],
            'signal' => $decoded
        ];
    }
}

echo json_encode(['ok' => true, 'signals' => $signals, 'last_id' => $last_id],
    JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
