<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
require_once __DIR__ . '/../bd/database.php';
require_once __DIR__ . '/../bd/desktop_session.php';
desktop_cors();
@mysqli_set_charset($link, 'utf8mb4');

function dm_out(array $value, int $status = 200): never {
    http_response_code($status);
    echo json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function dm_current_user(mysqli $link): int {
    $id = isset($_COOKIE['id']) ? (int)$_COOKIE['id'] : desktop_session_user($link);
    if ($id < 1) dm_out(['ok' => false, 'error' => 'Сессия истекла'], 401);
    return $id;
}

$uid = dm_current_user($link);
mysqli_query($link, "CREATE TABLE IF NOT EXISTS direct_messages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sender_id INT NOT NULL,
    receiver_id INT NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    read_at DATETIME NULL,
    INDEX dm_sender_receiver (sender_id, receiver_id, id),
    INDEX dm_receiver_read (receiver_id, read_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$action = (string)($_GET['action'] ?? $_POST['action'] ?? '');

if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'list') {
    $sql = "SELECT d.id,d.sender_id,d.receiver_id,d.message,d.created_at,
        (SELECT COUNT(*) FROM direct_messages u WHERE u.sender_id=IF(d.sender_id=$uid,d.receiver_id,d.sender_id) AND u.receiver_id=$uid AND u.read_at IS NULL) unread
        FROM direct_messages d
        INNER JOIN (SELECT IF(sender_id=$uid,receiver_id,sender_id) peer,MAX(id) max_id FROM direct_messages WHERE sender_id=$uid OR receiver_id=$uid GROUP BY peer) x ON x.max_id=d.id
        ORDER BY d.id DESC";
    $result = mysqli_query($link, $sql);
    $threads = [];
    while ($result && $row = mysqli_fetch_assoc($result)) {
        $threads[] = ['peer_id' => (int)$row['sender_id'] === $uid ? (int)$row['receiver_id'] : (int)$row['sender_id'], 'last_message' => $row['message'], 'updated_at' => $row['created_at'], 'unread' => (int)$row['unread']];
    }
    dm_out(['ok' => true, 'threads' => $threads]);
}

if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'thread') {
    $peer = (int)($_GET['user_id'] ?? 0);
    if ($peer < 1 || $peer === $uid) dm_out(['ok' => false, 'error' => 'Некорректный собеседник'], 422);
    mysqli_query($link, "UPDATE direct_messages SET read_at=NOW() WHERE sender_id=$peer AND receiver_id=$uid AND read_at IS NULL");
    $result = mysqli_query($link, "SELECT id,sender_id,receiver_id,message,created_at,read_at FROM direct_messages WHERE (sender_id=$uid AND receiver_id=$peer) OR (sender_id=$peer AND receiver_id=$uid) ORDER BY id DESC LIMIT 300");
    $messages = [];
    while ($result && $row = mysqli_fetch_assoc($result)) $messages[] = ['id'=>(int)$row['id'],'sender_id'=>(int)$row['sender_id'],'receiver_id'=>(int)$row['receiver_id'],'message'=>$row['message'],'created_at'=>$row['created_at'],'read_at'=>$row['read_at']];
    dm_out(['ok' => true, 'messages' => array_reverse($messages)]);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && in_array($action, ['edit','delete'], true)) {
    $id = (int)($_POST['id'] ?? 0);
    if ($id < 1) dm_out(['ok'=>false,'error'=>'Некорректное сообщение'],422);
    $stmt = mysqli_prepare($link, 'SELECT sender_id,message FROM direct_messages WHERE id=?');
    mysqli_stmt_bind_param($stmt,'i',$id); mysqli_stmt_execute($stmt);
    $row = mysqli_fetch_assoc(mysqli_stmt_get_result($stmt)); mysqli_stmt_close($stmt);
    if (!$row || (int)$row['sender_id'] !== $uid) dm_out(['ok'=>false,'error'=>'Можно изменять только свои сообщения'],403);
    if ($action === 'edit') {
        $message=trim((string)($_POST['message'] ?? ''));
        if ($message==='' || mb_strlen($message)>2000 || str_starts_with((string)$row['message'],'[[') || str_starts_with($message,'[[')) dm_out(['ok'=>false,'error'=>'Это сообщение нельзя редактировать'],422);
        $stmt=mysqli_prepare($link,'UPDATE direct_messages SET message=? WHERE id=? AND sender_id=?');
        mysqli_stmt_bind_param($stmt,'sii',$message,$id,$uid);
    } else {
        $stmt=mysqli_prepare($link,'DELETE FROM direct_messages WHERE id=? AND sender_id=?');
        mysqli_stmt_bind_param($stmt,'ii',$id,$uid);
    }
    if (!mysqli_stmt_execute($stmt)) dm_out(['ok'=>false,'error'=>'Не удалось сохранить изменение'],500);
    mysqli_stmt_close($stmt); dm_out(['ok'=>true]);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'send') {
    $peer = (int)($_POST['user_id'] ?? 0);
    $message = trim((string)($_POST['message'] ?? ''));
    if ($peer < 1 || $peer === $uid || $message === '') dm_out(['ok' => false, 'error' => 'Введите сообщение'], 422);
    $friend = mysqli_query($link, "SELECT 1 FROM friends WHERE status=1 AND ((user_id=$uid AND friend_id=$peer) OR (user_id=$peer AND friend_id=$uid)) LIMIT 1");
    if (!$friend || !mysqli_fetch_row($friend)) dm_out(['ok' => false, 'error' => 'Личные сообщения доступны только друзьям'], 403);
    $message = function_exists('mb_substr') ? mb_substr($message, 0, 2000) : substr($message, 0, 2000);
    $escaped = mysqli_real_escape_string($link, $message);
    if (!mysqli_query($link, "INSERT INTO direct_messages(sender_id,receiver_id,message) VALUES($uid,$peer,'$escaped')")) dm_out(['ok' => false, 'error' => 'Не удалось отправить сообщение'], 500);
    dm_out(['ok' => true, 'message' => ['id'=>(int)mysqli_insert_id($link),'sender_id'=>$uid,'receiver_id'=>$peer,'message'=>$message,'created_at'=>date('Y-m-d H:i:s'),'read_at'=>null]]);
}

dm_out(['ok' => false, 'error' => 'Неизвестное действие'], 400);
