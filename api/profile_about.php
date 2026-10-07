<?php
// Shared Kitchat profile description storage.
declare(strict_types=1);
require_once __DIR__.'/../bd/database.php';
require_once __DIR__.'/../bd/desktop_session.php';
desktop_cors();
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
mysqli_set_charset($link, 'utf8mb4');

function profile_about_out(array $data, int $status = 200): void {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function profile_about_prepare(mysqli $db): void {
    $sql = "CREATE TABLE IF NOT EXISTS desktop_profile_about (
        user_id INT NOT NULL PRIMARY KEY,
        about VARCHAR(190) NOT NULL DEFAULT '',
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_profile_about_updated (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
    if (!$db->query($sql)) profile_about_out(['ok'=>false,'error'=>'Не удалось подготовить профили'],500);
}

$me = desktop_session_user($link);
if ($me <= 0) profile_about_out(['ok'=>false,'error'=>'Сессия истекла'],401);
profile_about_prepare($link);
$action = (string)($_GET['action'] ?? 'get');

if ($action === 'get' && $_SERVER['REQUEST_METHOD'] === 'GET') {
    $userId = max(1, (int)($_GET['user_id'] ?? $me));
    $statement = $link->prepare('SELECT about FROM desktop_profile_about WHERE user_id=? LIMIT 1');
    $statement->bind_param('i', $userId);
    $statement->execute();
    $row = $statement->get_result()->fetch_assoc();
    $statement->close();
    profile_about_out(['ok'=>true,'user_id'=>$userId,'about'=>(string)($row['about'] ?? '')]);
}

if ($action === 'set' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $about = trim((string)($_POST['about'] ?? ''));
    $about = function_exists('mb_substr') ? mb_substr($about, 0, 190) : substr($about, 0, 190);
    $statement = $link->prepare('INSERT INTO desktop_profile_about(user_id,about) VALUES(?,?) ON DUPLICATE KEY UPDATE about=VALUES(about),updated_at=CURRENT_TIMESTAMP');
    $statement->bind_param('is', $me, $about);
    if (!$statement->execute()) profile_about_out(['ok'=>false,'error'=>'Не удалось сохранить описание'],500);
    $statement->close();
    profile_about_out(['ok'=>true,'user_id'=>$me,'about'=>$about]);
}

profile_about_out(['ok'=>false,'error'=>'Неизвестное действие'],400);
