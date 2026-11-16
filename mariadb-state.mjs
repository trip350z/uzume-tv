import { execFileSync } from 'node:child_process';

export function mariaDbStore(database) {
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(database)) throw new Error('MariaDBのデータベース名が不正です');
    function query(sql) {
        return execFileSync('mariadb', ['--protocol=socket', '--batch', '--raw', '--skip-column-names', database], {
            input: sql, encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024
        }).trim();
    }
    return {
        load(initial) {
            query('CREATE TABLE IF NOT EXISTS dvr_state (id TINYINT PRIMARY KEY, payload JSON NOT NULL) ENGINE=InnoDB');
            const stored = query('SELECT payload FROM dvr_state WHERE id=1');
            return stored ? JSON.parse(stored) : initial();
        },
        save(state) {
            const hex = Buffer.from(JSON.stringify(state)).toString('hex');
            query("INSERT INTO dvr_state (id,payload) VALUES (1,CONVERT(X'" + hex +
                "' USING utf8mb4)) ON DUPLICATE KEY UPDATE payload=VALUES(payload)");
        }
    };
}
