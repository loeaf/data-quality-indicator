const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const mysql = require('mysql2/promise')
const { Client } = require('pg')
const oracledb = require('oracledb')
const fs = require('fs').promises
const os = require('os')

let mainWindow = null
let dbConnection = null
let dbType = null

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    })

    mainWindow.loadFile('index.html')
}

app.whenReady().then(() => {
    createWindow()
})

// 데이터베이스 연결 테스트
ipcMain.handle('test-connection', async (event, config) => {
    try {
        const testConn = await createConnection(config)
        await closeConnection(testConn)
        return { success: true }
    } catch (error) {
        throw new Error('연결 테스트 실패: ' + error.message)
    }
})

async function createConnection(config) {
    switch (config.type) {
        case 'mysql':
            return await mysql.createConnection({
                host: config.host,
                port: config.port,
                user: config.username,
                password: config.password,
                database: config.database
            })

        case 'postgresql':
            const pgClient = new Client({
                host: config.host,
                port: config.port,
                user: config.username,
                password: config.password,
                database: config.database
            })
            await pgClient.connect()
            return pgClient

        case 'oracle':
            return await oracledb.getConnection({
                user: config.username,
                password: config.password,
                connectString: `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${config.host})(PORT=${config.port}))(CONNECT_DATA=(SID=${config.sid})))`
            })

        default:
            throw new Error('지원하지 않는 데이터베이스 타입입니다.')
    }
}

async function closeConnection(conn) {
    if (!conn) return

    switch (dbType) {
        case 'mysql':
            await conn.end()
            break
        case 'postgresql':
            await conn.end()
            break
        case 'oracle':
            await conn.close()
            break
    }
}

// 테이블 목록 조회 쿼리
async function getTableListQuery(config) {
    switch (config.type) {
        case 'postgresql':
            return `
                WITH table_columns AS (
                    SELECT
                        t.table_name,
                        COUNT(c.column_name) as column_count,
                        string_agg(c.column_name::text, ',' ORDER BY c.column_name) as columns
                    FROM information_schema.tables t
                             JOIN information_schema.columns c ON t.table_name = c.table_name
                    WHERE t.table_schema = 'public'
                      AND t.table_type = 'BASE TABLE'
                    GROUP BY t.table_name
                ),
                     pk_info AS (
                         SELECT
                             tc.table_name,
                             string_agg(ccu.column_name::text, ',' ORDER BY ccu.column_name) as pk_columns
                         FROM information_schema.table_constraints tc
                                  JOIN information_schema.constraint_column_usage ccu
                                       ON tc.constraint_name = ccu.constraint_name
                         WHERE tc.constraint_type = 'PRIMARY KEY'
                           AND tc.table_schema = 'public'
                         GROUP BY tc.table_name
                     ),
                     duplicate_estimates AS (
                         SELECT
                             tc.table_name,
                             tc.column_count,
                             CASE
                                 WHEN pi.pk_columns IS NULL THEN 0  -- PK가 없는 경우
                                 ELSE (
                                     SELECT COUNT(*)
                                     FROM pg_stats
                                     WHERE schemaname = 'public'
                                       AND tablename = tc.table_name
                                       AND null_frac < 1  -- NULL이 아닌 값이 있는 컬럼만
                                       AND n_distinct > 0  -- 중복값이 있는 컬럼만
                                       AND attname NOT IN (SELECT UNNEST(string_to_array(pi.pk_columns, ',')))  -- PK 제외
                                 )
                                 END as duplicate_estimate
                         FROM table_columns tc
                                  LEFT JOIN pk_info pi ON tc.table_name = pi.table_name
                     )
                SELECT
                    table_name as name,
                    column_count as columns,
                    COALESCE(duplicate_estimate, 0) as duplicate_datas
                FROM duplicate_estimates
                ORDER BY table_name
            `
    }
}

// 컬럼 정보 조회 쿼리
async function getColumnInfoQuery(config, tableName) {
    switch (config.type) {
        case 'mysql':
            return {
                query: `
                    SELECT 
                        COLUMN_NAME as name,
                        COLUMN_TYPE as type,
                        IS_NULLABLE as nullable,
                        COLUMN_KEY as \`key\`,
                        COLUMN_DEFAULT as \`default\`,
                        EXTRA as extra
                    FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_SCHEMA = DATABASE()
                    AND TABLE_NAME = ?
                    ORDER BY ORDINAL_POSITION
                `,
                params: [tableName]
            }
        case 'postgresql':
            return {
                query: `
                    SELECT
                        c.column_name as name,
                        c.data_type as type,
                        c.is_nullable as nullable,
                        CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END as key,
                c.column_default as "default",
                '' as extra
                    FROM information_schema.columns c
                        LEFT JOIN (
                        SELECT ku.column_name, tc.table_name
                        FROM information_schema.table_constraints tc
                        JOIN information_schema.key_column_usage ku
                        ON tc.constraint_name = ku.constraint_name
                        WHERE tc.constraint_type = 'PRIMARY KEY'
                        AND ku.table_name = $1
                        ) pk ON c.column_name = pk.column_name AND c.table_name = pk.table_name
                    WHERE c.table_name = $1
                      AND c.table_schema = 'public'
                    ORDER BY c.ordinal_position
                `,
                params: [tableName]
            }
        case 'oracle':
            return {
                query: `
                    SELECT 
                        column_name as name,
                        data_type || '(' || data_length || ')' as type,
                        nullable,
                        CASE WHEN constraint_type = 'P' THEN 'PRI' ELSE '' END as key,
                        data_default as "default",
                        '' as extra
                    FROM all_tab_columns c
                    LEFT JOIN (
                        SELECT cols.column_name, cons.constraint_type
                        FROM all_constraints cons
                        JOIN all_cons_columns cols
                            ON cons.constraint_name = cols.constraint_name
                        WHERE cons.constraint_type = 'P'
                        AND cols.table_name = :1
                    ) pk ON c.column_name = pk.column_name
                    WHERE c.table_name = :1
                    AND c.owner = USER
                    ORDER BY column_id
                `,
                params: [tableName]
            }
    }
}

// 데이터베이스 연결 처리
ipcMain.handle('connect-database', async (event, config) => {
    try {
        if (dbConnection) {
            await closeConnection(dbConnection)
        }

        dbConnection = await createConnection(config)
        dbType = config.type

        const query = await getTableListQuery(config)
        let tables

        switch (config.type) {
            case 'mysql':
                const [rows] = await dbConnection.query(query)
                tables = rows
                break
            case 'postgresql':
                const result = await dbConnection.query(query)
                console.log(result)
                tables = result.rows
                break
            case 'oracle':
                const oracleResult = await dbConnection.execute(query, [], { outFormat: oracledb.OUT_FORMAT_OBJECT })
                tables = oracleResult.rows
                break
        }

        return tables

    } catch (error) {
        throw new Error('데이터베이스 연결 실패: ' + error.message)
    }
})

// 테이블 상세 정보 조회
ipcMain.handle('get-table-details', async (event, tableName) => {
    try {
        if (!dbConnection) {
            throw new Error('데이터베이스 연결이 없습니다')
        }

        const queryInfo = await getColumnInfoQuery({ type: dbType }, tableName)
        let columns

        switch (dbType) {
            case 'mysql':
                const [rows] = await dbConnection.query(queryInfo.query, queryInfo.params)
                columns = rows
                break
            case 'postgresql':
                const result = await dbConnection.query(queryInfo.query, queryInfo.params)
                columns = result.rows
                break
            case 'oracle':
                const oracleResult = await dbConnection.execute(
                    queryInfo.query,
                    queryInfo.params,
                    { outFormat: oracledb.OUT_FORMAT_OBJECT }
                )
                columns = oracleResult.rows
                break
        }

        return columns

    } catch (error) {
        throw new Error('테이블 정보 조회 실패: ' + error.message)
    }
})


// 저장된 연결 정보 파일 경로
const connectionsPath = path.join(os.homedir(), '.db-explorer', 'connections.json')

// 연결 정보 저장 핸들러
ipcMain.handle('save-connection', async (event, connection) => {
    try {
        // .db-explorer 디렉토리 생성
        await fs.mkdir(path.dirname(connectionsPath), { recursive: true })

        // 기존 연결 정보 불러오기
        let connections = []
        try {
            const data = await fs.readFile(connectionsPath, 'utf8')
            connections = JSON.parse(data)
        } catch (error) {
            // 파일이 없는 경우 무시
        }

        // 동일한 이름의 연결이 있는지 확인
        const index = connections.findIndex(conn => conn.name === connection.name)
        if (index >= 0) {
            connections[index] = connection
        } else {
            connections.push(connection)
        }

        // 파일에 저장
        await fs.writeFile(connectionsPath, JSON.stringify(connections, null, 2))
        return { success: true }
    } catch (error) {
        throw new Error('연결 정보 저장 실패: ' + error.message)
    }
})

// 연결 정보 목록 조회 핸들러
ipcMain.handle('get-connections', async () => {
    try {
        const data = await fs.readFile(connectionsPath, 'utf8')
        return JSON.parse(data)
    } catch (error) {
        return []
    }
})

// 연결 정보 삭제 핸들러
ipcMain.handle('delete-connection', async (event, connectionName) => {
    try {
        const data = await fs.readFile(connectionsPath, 'utf8')
        let connections = JSON.parse(data)
        connections = connections.filter(conn => conn.name !== connectionName)
        await fs.writeFile(connectionsPath, JSON.stringify(connections, null, 2))
        return { success: true }
    } catch (error) {
        throw new Error('연결 정보 삭제 실패: ' + error.message)
    }
})


// 컬럼별 중복 데이터 정보 조회
ipcMain.handle('get-data-duplicates', async (event, tableName) => {
    try {
        if (!dbConnection) {
            throw new Error('데이터베이스 연결이 없습니다')
        }

        // 쿼리 생성

        // 쿼리 실행 후 쿼리 결과 반환

        // 결과 쿼리를 가지고 중복 테이블 데이터 정보 반환

        const queryInfo = await getDataDuplicatesQuery({ type: dbType }, tableName)
        let duplicates

        switch (dbType) {
            case 'mysql':
                const [rows] = await dbConnection.query(queryInfo.query, queryInfo.params)
                duplicates = rows
                break
            case 'postgresql':
                const result = await dbConnection.query(queryInfo.query, queryInfo.params)
                duplicates = result.rows
                break
            case 'oracle':
                const oracleResult = await dbConnection.execute(
                    queryInfo.query,
                    queryInfo.params,
                    { outFormat: oracledb.OUT_FORMAT_OBJECT }
                )
                duplicates = oracleResult.rows
                break
        }

        return duplicates

    } catch (error) {
        throw new Error('중복 데이터 조회 실패: ' + error.message)
    }
})

// PostgreSQL 컬럼 선택 쿼리 생성 헬퍼 함수 추가
async function getColumnSelections(tableName) {
    const { rows } = await dbConnection.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = $1
    `, [tableName]);

    return rows.map(row =>
        `WHEN '${row.column_name}' THEN tbl."${row.column_name}"`
    ).join('\n');
}

async function getDataDuplicatesQuery(config, tableName) {
    switch (config.type) {
        case 'postgresql':
            // 1단계: 중복을 확인할 컬럼 목록 가져오기
            const columnsQuery = {
                query: `
                    WITH pk_columns AS (
                        SELECT array_agg(ccu.column_name) as pk_cols
                        FROM information_schema.table_constraints tc
                                 JOIN information_schema.constraint_column_usage ccu
                                      ON tc.constraint_name = ccu.constraint_name
                        WHERE tc.table_name = $1
                          AND tc.constraint_type = 'PRIMARY KEY'
                          AND tc.table_schema = 'public'
                    )
                    SELECT
                        column_name,
                        data_type
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = $1
                      AND column_name != ALL(COALESCE((SELECT pk_cols FROM pk_columns), ARRAY[]::varchar[]))`,
                params: [tableName]
            };

            const { rows: columns } = await dbConnection.query(columnsQuery.query, columnsQuery.params);

            // 2단계: 각 컬럼 타입에 맞는 캐스팅 적용
            const columnExpressions = columns.map(col => {
                let castExpression;
                switch (col.data_type.toLowerCase()) {
                    case 'geometry':
                        castExpression = `ST_AsText(${col.column_name})`;
                        break;
                    default:
                        castExpression = `COALESCE(${col.column_name}::text, 'NULL')`;
                }
                return `${castExpression}`;
            });

            // 3단계: 최종 쿼리 생성
            return {
                query: `
                    SELECT 
                        ROW_NUMBER() OVER () as id,
                        concat_ws(',', ${columnExpressions.join(', ')}) as value,
                        COUNT(*) as count
                    FROM ${tableName}
                    GROUP BY ${columnExpressions.join(', ')}
                    HAVING COUNT(*) > 1
                    ORDER BY COUNT(*) DESC
                    LIMIT 5`,
                params: []
            };
    }
}
// PostgreSQL 컬럼 케이스 생성을 위한 헬퍼 함수
async function getColumnCases(tableName) {
    const { rows } = await dbConnection.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = $1
        ORDER BY ordinal_position
    `, [tableName]);

    return rows.map(row =>
        `WHEN '${row.column_name}' THEN t.${row.column_name}`
    ).join('\n');
}

