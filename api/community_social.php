<?php
// Lightweight shared snapshot for friends and member presence, including voice-only views.
require_once __DIR__.'/../bd/database.php';
require_once __DIR__.'/../bd/desktop_session.php';
if(!function_exists('desktop_online_expression')){function desktop_online_expression(string $userAlias='u'):string{$alias=preg_replace('/[^a-z0-9_]/i','',$userAlias)?:'u';return "$alias.last_seen>=DATE_SUB(NOW(),INTERVAL 20 SECOND)";}}
desktop_cors();
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
mysqli_set_charset($link, 'utf8mb4');
$uid = desktop_session_user($link);
if ($uid <= 0) $uid = (int)($_COOKIE['id'] ?? 0);
if ($uid <= 0) { http_response_code(401); echo json_encode(['ok'=>false,'error'=>'Сессия истекла']); exit; }
mysqli_query($link, "CREATE TABLE IF NOT EXISTS desktop_profile_about(user_id INT NOT NULL PRIMARY KEY,about VARCHAR(190) NOT NULL DEFAULT '',updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,INDEX idx_profile_about_updated(updated_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
set_exception_handler(function(Throwable $error) {
    error_log('community social: '.$error->getMessage());
    http_response_code(500); echo json_encode(['ok'=>false,'error'=>'Не удалось обновить список пользователей']);
});
$sid = max(0, (int)($_GET['server_id'] ?? 0));
$online = desktop_online_expression('u');
$people = [];
$result = mysqli_query($link, "SELECT u.id,u.name,u.avatar,COALESCE(pa.about,'') about,$online online,f.status,f.user_id request_sender
    FROM user u LEFT JOIN desktop_profile_about pa ON pa.user_id=u.id JOIN friends f ON ((f.user_id=$uid AND f.friend_id=u.id) OR (f.friend_id=$uid AND f.user_id=u.id))
    WHERE u.id<>$uid ORDER BY f.status DESC,online DESC,u.name,u.id");
while ($p = mysqli_fetch_assoc($result)) $people[] = ['id'=>(int)$p['id'],'name'=>$p['name'],'avatar'=>$p['avatar'],'about'=>$p['about'],'online'=>(bool)$p['online'],'friend_status'=>(int)$p['status'],'sent_by_me'=>(int)$p['request_sender']===$uid];
$members = [];
if ($sid) {
    $result = mysqli_query($link, "SELECT u.id,u.name,u.avatar,COALESCE(pa.about,'') about,u.global_role,m.role,$online online
        FROM community_server_members m JOIN user u ON u.id=m.user_id LEFT JOIN desktop_profile_about pa ON pa.user_id=u.id
        WHERE m.server_id=$sid AND EXISTS(SELECT 1 FROM community_server_members viewer WHERE viewer.server_id=$sid AND viewer.user_id=$uid)
        ORDER BY online DESC,u.name,u.id");
    while ($p = mysqli_fetch_assoc($result)) $members[] = ['id'=>(int)$p['id'],'name'=>$p['name'],'avatar'=>$p['avatar'],'about'=>$p['about'],'global_role'=>$p['global_role'],'role'=>$p['role'],'online'=>(bool)$p['online']];
}
echo json_encode(['ok'=>true,'people'=>$people,'server_members'=>$members,'server_time'=>time(),'presence_ttl'=>20], JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
