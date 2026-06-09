const mysql = require('mysql2/promise');
require('dotenv').config();

// Configuración del pool de conexiones para manejar múltiples peticiones concurrentemente
// Reemplaza los datos locales por los datos reales de internet en tu archivo de configuración:
const pool = mysql.createPool({
    host: 'db.nayuki.cl',
    port: 3306,
    user: 'root',
    password: 'EcoPanCapstone',
    database: 'ecopan',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Verificación inicial de la conexión
pool.getConnection()
    .then(connection => {
        console.log('✅ Conexión a la base de datos MySQL establecida correctamente.');
        connection.release();
    })
    .catch(err => {
        console.error('Error al conectar a la base de datos MySQL:', err.message);
    });

module.exports = pool;
