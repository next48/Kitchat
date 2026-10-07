<?php
function desktop_session_prepare(mysqli $db): void {
    $db->query("CREATE TABLE IF NOT EXISTS desktop_sessions (
        token_hash CHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_desktop_user (user_id), KEY idx_desktop_expiry (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $db->query("DELETE FROM desktop_sessions WHERE expires_at < NOW()");
}
function desktop_bearer_token(): string {
    $header=(string)($_SERVER['HTTP_AUTHORIZATION']??'');
    return preg_match('/^Bearer\s+([A-Za-z0-9_-]{32,})$/i',$header,$m)?$m[1]:'';
}
function desktop_session_hash(): string {
    $token=desktop_bearer_token();
    return $token===''?'':hash('sha256',$token);
}
function desktop_session_user(mysqli $db): int {
    $hash=desktop_session_hash(); if($hash==='') return 0;
    desktop_session_prepare($db);
    $st=$db->prepare('SELECT user_id FROM desktop_sessions WHERE token_hash=? AND expires_at>NOW() LIMIT 1');
    if(!$st)return 0; $st->bind_param('s',$hash);$st->execute();$row=$st->get_result()->fetch_assoc();$st->close();
    $userId=(int)($row['user_id']??0);
    if($userId>0){$touch=$db->prepare('UPDATE desktop_sessions SET last_seen_at=NOW() WHERE token_hash=?');if($touch){$touch->bind_param('s',$hash);$touch->execute();$touch->close();}}
    return $userId;
}
function desktop_session_presence_leave(mysqli $db): void {
    $hash=desktop_session_hash(); if($hash==='') return;
    $st=$db->prepare("UPDATE desktop_sessions SET last_seen_at='2000-01-01 00:00:00' WHERE token_hash=?");
    if($st){$st->bind_param('s',$hash);$st->execute();$st->close();}
}
function desktop_online_expression(string $userAlias='u'): string {
    $alias=preg_replace('/[^a-z0-9_]/i','',$userAlias)?:'u';
    return "EXISTS(SELECT 1 FROM desktop_sessions online_session WHERE online_session.user_id=$alias.id AND online_session.expires_at>NOW() AND online_session.last_seen_at>=DATE_SUB(NOW(),INTERVAL 20 SECOND))";
}
function desktop_session_create(mysqli $db,int $userId): string {
    desktop_session_prepare($db);$token=rtrim(strtr(base64_encode(random_bytes(48)),'+/','-_'),'=');$hash=hash('sha256',$token);
    $st=$db->prepare('INSERT INTO desktop_sessions(token_hash,user_id,expires_at) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 30 DAY))');
    $st->bind_param('si',$hash,$userId);$st->execute();$st->close();return $token;
}
function desktop_oauth_code_create(mysqli $db,int $userId): string {
    $db->query("CREATE TABLE IF NOT EXISTS desktop_oauth_codes (
        code_hash CHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_desktop_oauth_expiry (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $db->query("DELETE FROM desktop_oauth_codes WHERE expires_at < NOW()");
    $code=rtrim(strtr(base64_encode(random_bytes(48)),'+/','-_'),'=');$hash=hash('sha256',$code);
    $st=$db->prepare('INSERT INTO desktop_oauth_codes(code_hash,user_id,expires_at) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 2 MINUTE))');
    $st->bind_param('si',$hash,$userId);$st->execute();$st->close();return $code;
}
function desktop_oauth_code_consume(mysqli $db,string $code): int {
    if(!preg_match('/^[A-Za-z0-9_-]{40,100}$/',$code)) return 0;
    $db->query("CREATE TABLE IF NOT EXISTS desktop_oauth_codes (code_hash CHAR(64) PRIMARY KEY,user_id INT NOT NULL,expires_at DATETIME NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,KEY idx_desktop_oauth_expiry (expires_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $hash=hash('sha256',$code);$db->begin_transaction();
    try{$st=$db->prepare('SELECT user_id FROM desktop_oauth_codes WHERE code_hash=? AND expires_at>NOW() FOR UPDATE');$st->bind_param('s',$hash);$st->execute();$row=$st->get_result()->fetch_assoc();$st->close();$del=$db->prepare('DELETE FROM desktop_oauth_codes WHERE code_hash=?');$del->bind_param('s',$hash);$del->execute();$del->close();$db->commit();return (int)($row['user_id']??0);}catch(Throwable $e){$db->rollback();throw $e;}
}
function desktop_cors(): void {
    $origin=(string)($_SERVER['HTTP_ORIGIN']??'');
    if(in_array($origin,['http://tauri.localhost','https://tauri.localhost','tauri://localhost'],true)) header('Access-Control-Allow-Origin: '.$origin);
    header('Vary: Origin');header('Access-Control-Allow-Headers: Content-Type, Authorization');header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    if(($_SERVER['REQUEST_METHOD']??'')==='OPTIONS'){http_response_code(204);exit;}
}
