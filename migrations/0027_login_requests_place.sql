-- スマホで承認してログイン：申請した場所（承認画面に出して、なりすましに気づけるように）と、片付け用の索引
ALTER TABLE login_requests ADD COLUMN ip TEXT;
ALTER TABLE login_requests ADD COLUMN place TEXT;
CREATE INDEX login_requests_expires ON login_requests(expires_at);
