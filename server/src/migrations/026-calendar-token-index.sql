-- index users(calendar_token) so the open calendar feed route looks up a token without scanning users. Undo: DROP INDEX IF EXISTS users_calendar_token
CREATE INDEX IF NOT EXISTS users_calendar_token ON users(calendar_token);
