const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
require('dotenv').config();

// 1. Única importación de base de datos necesaria. 
// El pool ya maneja las promesas y variables de entorno desde config/db.js
const pool = require('./config/db');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// ============================================================================
// HELPERS DE VALIDACIÓN Y SEGURIDAD
// ============================================================================

// Función helper de validación estricta para ventas e ítems
function validateVentaData(venta) {
    if (!venta) return { valid: false, error: "Datos de venta vacíos o nulos" };

    const { id, cajera_id, sucursal_id, total, estado, fecha, items } = venta;

    // Si viene id, debe ser un entero positivo
    if (id !== undefined && id !== null && (!Number.isInteger(Number(id)) || Number(id) <= 0)) {
        return { valid: false, error: "El ID de venta debe ser un entero positivo." };
    }

    // sucursal_id debe ser un entero positivo
    if (sucursal_id === undefined || sucursal_id === null || !Number.isInteger(Number(sucursal_id)) || Number(sucursal_id) <= 0) {
        return { valid: false, error: "El sucursal_id es requerido y debe ser un entero positivo." };
    }

    // cajera_id puede ser nulo o un entero positivo
    if (cajera_id !== undefined && cajera_id !== null && (!Number.isInteger(Number(cajera_id)) || Number(cajera_id) <= 0)) {
        return { valid: false, error: "El cajera_id debe ser un entero positivo o nulo." };
    }

    // total debe ser un número entero >= 0
    if (total === undefined || total === null || !Number.isInteger(Number(total)) || Number(total) < 0) {
        return { valid: false, error: "El total de la venta es requerido y debe ser un número entero no negativo." };
    }

    // estado debe ser uno de 'pagado', 'pendiente', 'anulado'
    const estadosValidos = ['pagado', 'pendiente', 'anulado'];
    if (estado !== undefined && estado !== null && !estadosValidos.includes(estado)) {
        return { valid: false, error: "El estado de la venta debe ser 'pagado', 'pendiente' o 'anulado'." };
    }

    // fecha debe ser válida
    if (!fecha || isNaN(Date.parse(fecha))) {
        return { valid: false, error: "La fecha de la venta es requerida y debe ser una fecha/hora válida." };
    }

    // items debe ser un array no vacío
    if (!Array.isArray(items) || items.length === 0) {
        return { valid: false, error: "La venta debe contener al menos un ítem." };
    }

    // Validar cada ítem
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const { producto_id, cantidad, peso_kg, subtotal } = item;

        if (producto_id === undefined || producto_id === null || !Number.isInteger(Number(producto_id)) || Number(producto_id) <= 0) {
            return { valid: false, error: `Ítem en posición ${i}: producto_id es requerido y debe ser un entero positivo.` };
        }

        if (cantidad === undefined || cantidad === null || isNaN(Number(cantidad)) || Number(cantidad) <= 0) {
            return { valid: false, error: `Ítem en posición ${i}: cantidad es requerida y debe ser un número positivo.` };
        }

        if (peso_kg !== undefined && peso_kg !== null && (isNaN(Number(peso_kg)) || Number(peso_kg) < 0)) {
            return { valid: false, error: `Ítem en posición ${i}: peso_kg debe ser un número positivo o nulo.` };
        }

        if (subtotal === undefined || subtotal === null || !Number.isInteger(Number(subtotal)) || Number(subtotal) < 0) {
            return { valid: false, error: `Ítem en posición ${i}: subtotal es requerido y debe ser un número entero no negativo.` };
        }
    }

    return { valid: true };
}

// Helper para verificar duplicados por ID
async function saleExists(connection, id) {
    const [rows] = await connection.execute('SELECT 1 FROM ventas WHERE id = ?', [id]);
    return rows.length > 0;
}

// ============================================================================
// 1. ENDPOINT POST DE VENTAS (/api/ventas) Y LÓGICA DE PAN MIXTO
// ============================================================================
app.post('/api/ventas', async (req, res) => {
    const valResult = validateVentaData(req.body);
    if (!valResult.valid) {
        return res.status(400).json({ error: valResult.error });
    }

    const { cajera_id, sucursal_id, total, estado, fecha, items } = req.body;

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // Guardar la transacción principal (MySQL autogenerará el ID)
        const [resultVenta] = await connection.execute(
            `INSERT INTO ventas (cajera_id, sucursal_id, total, estado, fecha)
             VALUES (?, ?, ?, ?, ?)`,
            [
                cajera_id !== undefined ? cajera_id : null,
                sucursal_id,
                total,
                estado || 'pagado',
                fecha
            ]
        );

        const venta_id = resultVenta.insertId;

        for (let item of items) {
            if (item.is_mixed) {
                // --- Lógica de división de "Pan Mixto" ---
                // Consultar tabla produccion_plan para la sucursal en la fecha de la venta
                const ventaFechaStr = new Date(fecha).toISOString().slice(0, 10);
                const [producciones] = await connection.execute(
                    `SELECT producto_id, cantidad_kg 
                     FROM produccion_plan 
                     WHERE sucursal_id = ? 
                       AND fecha = ?`,
                    [sucursal_id, ventaFechaStr]
                );

                let distribucion = [];
                let total_kilos_producidos = 0;

                if (producciones.length > 0) {
                    total_kilos_producidos = producciones.reduce((sum, p) => sum + parseFloat(p.cantidad_kg), 0);
                    distribucion = producciones.map(p => ({
                        producto_id: p.producto_id,
                        porcentaje: parseFloat(p.cantidad_kg) / total_kilos_producidos
                    }));
                } else {
                    // Plan de contingencia: Promedio de kilos vendidos de los últimos 7 días
                    const [ventas_historicas] = await connection.execute(
                        `SELECT vd.producto_id, SUM(vd.peso_kg) as total_kg 
                         FROM venta_detalle vd
                         JOIN ventas v ON vd.venta_id = v.id
                         WHERE v.sucursal_id = ? 
                           AND v.fecha >= DATE_SUB(?, INTERVAL 7 DAY)
                         GROUP BY vd.producto_id`,
                        [sucursal_id, ventaFechaStr]
                    );

                    if (ventas_historicas.length > 0) {
                        total_kilos_producidos = ventas_historicas.reduce((sum, v) => sum + parseFloat(v.total_kg), 0);
                        distribucion = ventas_historicas.map(v => ({
                            producto_id: v.producto_id,
                            porcentaje: parseFloat(v.total_kg) / total_kilos_producidos
                        }));
                    } else {
                        throw new Error("No hay datos de producción ni históricos para distribuir el pan mixto.");
                    }
                }

                // Insertar los items divididos basándose en la proporción
                const cantidadTotal = parseFloat(item.cantidad);
                const subtotalTotal = parseFloat(item.subtotal);
                for (let dist of distribucion) {
                    const cant_dividida = Number((cantidadTotal * dist.porcentaje).toFixed(3));
                    const subtotal_dividido = Math.round(subtotalTotal * dist.porcentaje);

                    await connection.execute(
                        `INSERT INTO venta_detalle (venta_id, producto_id, cantidad, peso_kg, subtotal)
                         VALUES (?, ?, ?, ?, ?)`,
                        [venta_id, dist.producto_id, 1.0, cant_dividida, subtotal_dividido]
                    );
                }
            } else {
                // --- Producto normal (No Mixto) ---
                await connection.execute(
                    `INSERT INTO venta_detalle (venta_id, producto_id, cantidad, peso_kg, subtotal)
                     VALUES (?, ?, ?, ?, ?)`,
                    [
                        venta_id,
                        item.producto_id,
                        item.cantidad,
                        item.peso_kg !== undefined ? item.peso_kg : null,
                        item.subtotal
                    ]
                );
            }
        }

        await connection.commit();
        res.status(201).json({ message: "Venta registrada correctamente", venta_id });
    } catch (error) {
        await connection.rollback();
        console.error("Error al registrar venta:", error);
        res.status(500).json({ error: "Error interno del servidor al procesar la venta", detalle: error.message });
    } finally {
        connection.release();
    }
});


// ============================================================================
// 2. CONSUMO DE API METEOROLÓGICA DIARIA
// ============================================================================
async function fetchDailyWeather() {
    console.log("Iniciando consumo de API meteorológica...");
    try {
        // Obtener todas las sucursales activas desde la tabla real 'sucursales'
        const [sucursales] = await pool.query('SELECT id FROM sucursales');
        const hoy = new Date().toISOString().slice(0, 10); // Formato YYYY-MM-DD

        // Lógica para determinar si es fin de mes o día de pago
        const todayObj = new Date();
        const day = todayObj.getDate();
        const es_dia_pago = (day === 15 || day === 30 || day === 31);
        const lastDayOfMonth = new Date(todayObj.getFullYear(), todayObj.getMonth() + 1, 0).getDate();
        const es_fin_de_mes = (day === lastDayOfMonth);

        for (let branch of sucursales) {
            let temperatura_max = null;
            let clima_condicion = null;

            try {
                // Llamada a OpenWeatherMap (usando Santiago de Chile como coordenada por defecto, -33.4489, -70.6693)
                const API_KEY = process.env.WEATHER_API_KEY;
                if (!API_KEY) throw new Error("Falta la WEATHER_API_KEY");

                const lat = -33.4489;
                const lon = -70.6693;
                const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${API_KEY}&units=metric`;
                const response = await axios.get(url);

                temperatura_max = response.data.main.temp_max;
                clima_condicion = response.data.weather[0].main;

            } catch (apiError) {
                console.warn(`Advertencia: Falló la API de clima para la sucursal ${branch.id}. Se guardarán como NULL.`, apiError.message);
            }

            // Inserción en Daily_Context (IDEMPOTENTE usando ON DUPLICATE KEY UPDATE)
            await pool.query(
                `INSERT INTO Daily_Context (fecha, sucursal_id, temperatura_max, clima_condicion, es_fin_de_mes, es_dia_pago)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE 
                    temperatura_max = VALUES(temperatura_max),
                    clima_condicion = VALUES(clima_condicion),
                    es_fin_de_mes = VALUES(es_fin_de_mes),
                    es_dia_pago = VALUES(es_dia_pago)`,
                [hoy, branch.id, temperatura_max, clima_condicion, es_fin_de_mes, es_dia_pago]
            );
        }
        console.log(" Contexto diario de clima procesado y guardado.");
    } catch (dbError) {
        console.error(" Error en el proceso general de clima:", dbError);
    }
}

// Programamos la función de clima para que corra todos los días a las 23:50 por ejemplo
cron.schedule('50 23 * * *', () => {
    fetchDailyWeather();
});


// ============================================================================
// 3. CRON JOB DE CONSOLIDACIÓN (3:00 AM)
// ============================================================================
cron.schedule('0 3 * * *', async () => {
    console.log("⏱️ Iniciando cron job de consolidación analítica (3:00 AM)...");

    // Obtenemos la fecha de "ayer" para consolidar el día cerrado
    const ayerDate = new Date();
    ayerDate.setDate(ayerDate.getDate() - 1);
    const fechaAyer = ayerDate.toISOString().slice(0, 10);

    const connection = await pool.getConnection();

    try {
        const query = `
            INSERT INTO Analitica_Diaria (
                fecha, 
                sucursal_id, 
                total_ventas, 
                total_kg_vendidos, 
                total_kg_producidos,
                temperatura_max,
                clima_condicion
            )
            SELECT 
                ? as fecha,
                b.id as sucursal_id,
                IFNULL(SUM(t.total), 0) as total_ventas,
                IFNULL((SELECT SUM(vd.peso_kg) FROM venta_detalle vd JOIN ventas tr ON vd.venta_id = tr.id WHERE tr.sucursal_id = b.id AND DATE(tr.fecha) = ?), 0) as total_kg_vendidos,
                IFNULL((SELECT SUM(p.cantidad_kg) FROM produccion_plan p WHERE p.sucursal_id = b.id AND DATE(p.fecha) = ?), 0) as total_kg_producidos,
                dc.temperatura_max,
                dc.clima_condicion
            FROM sucursales b
            LEFT JOIN ventas t ON t.sucursal_id = b.id AND DATE(t.fecha) = ?
            LEFT JOIN Daily_Context dc ON dc.sucursal_id = b.id AND dc.fecha = ?
            GROUP BY b.id, dc.temperatura_max, dc.clima_condicion
            ON DUPLICATE KEY UPDATE 
                total_ventas = VALUES(total_ventas),
                total_kg_vendidos = VALUES(total_kg_vendidos),
                total_kg_producidos = VALUES(total_kg_producidos),
                temperatura_max = VALUES(temperatura_max),
                clima_condicion = VALUES(clima_condicion)
        `;

        await connection.query(query, [fechaAyer, fechaAyer, fechaAyer, fechaAyer, fechaAyer]);
        console.log("Consolidación diaria terminada con éxito (IDEMPOTENTE).");

    } catch (error) {
        console.error("Error en el cron job de consolidación:", error);
    } finally {
        connection.release();
    }
});


// ============================================================================
// 4. ENDPOINT PARA PREDICCIÓN ML (/api/predicciones)
// ============================================================================
app.get('/api/predicciones', async (req, res) => {
    const { sucursal_id } = req.query;

    if (!sucursal_id) {
        return res.status(400).json({ error: "Falta el parámetro 'sucursal_id'." });
    }

    try {
        // Simulación de llamada a un microservicio externo de Machine Learning
        // En un entorno real se haría algo como: 
        // const response = await axios.get(`http://microservicio-ml/predict?sucursal_id=${sucursal_id}`);

        // Objeto que simula la respuesta devuelta por el modelo ML con muchos decimales
        const simulatedMLResponse = {
            data: {
                kilos_recomendados: 125.87654321
            }
        };

        const rawValue = simulatedMLResponse.data.kilos_recomendados;

        // Forzando el valor a un número con un solo decimal, bloqueando decimales infinitos
        const kilos_redondeados = Number(rawValue.toFixed(1));

        res.status(200).json({
            sucursal_id,
            kilos_recomendados: kilos_redondeados
        });

    } catch (error) {
        console.error("Error al obtener predicción de ML:", error);
        res.status(500).json({ error: "Error interno al comunicarse con el microservicio de Machine Learning" });
    }
});

// ============================================================================
// RUTA TEMPORAL PARA VISUALIZAR LAS TABLAS DESDE EL NAVEGADOR
// ============================================================================
//app.get('/api/ver-tablas', async (req, res) => {
//    try {
// Hacemos una consulta para ver las tablas disponibles
//        const [tablas] = await pool.query("SHOW TABLES;");

// Hacemos otra consulta para ver las sucursales (Branch) como ejemplo
//        const [sucursales] = await pool.query("SELECT * FROM Branch LIMIT 10;");

// Te mostramos todo bien bonito en la pantalla
//        res.json({
//            mensaje: "¡Conexión visual exitosa!",
//            tablas_existentes: tablas,
//            datos_sucursales: sucursales
//        });
//    } catch (error) {
//        res.status(500).json({ error: "Error al consultar la BD", detalle: error.message });
//    }
//});

// ============================================================================
// RUTA TEMPORAL REVISADA (Solo para listar tablas existentes)
// ============================================================================
app.get('/api/ver-tablas', async (req, res) => {
    try {
        // Consultamos solo las tablas que existen en la base de datos
        const [tablas] = await pool.query("SHOW TABLES;");

        res.json({
            mensaje: "¡Conexión visual exitosa!",
            tablas_existentes: tablas
        });
    } catch (error) {
        res.status(500).json({ error: "Error al consultar la BD", detalle: error.message });
    }
});




// ============================================================================
// 1.5. ENDPOINT DE SINCRONIZACIÓN DESDE EL POS (/api/ventas/sync)
// ============================================================================
app.post('/api/ventas/sync', async (req, res) => {
    const { ventas } = req.body;

    if (!Array.isArray(ventas) || ventas.length === 0) {
        return res.status(400).json({ error: "Debe enviar un array 'ventas' con datos para sincronizar." });
    }

    // Validar todas las ventas antes de procesar ninguna (todo o nada)
    for (let venta of ventas) {
        const valResult = validateVentaData(venta);
        if (!valResult.valid) {
            return res.status(400).json({ error: `Venta ID ${venta.id || 'desconocido'}: ${valResult.error}` });
        }
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        let insertadas = 0;
        let duplicadas = 0;

        for (let venta of ventas) {
            try {
                // Verificar si ya existe en la base de datos central
                const exists = await saleExists(connection, venta.id);
                if (exists) {
                    duplicadas++;
                    continue;
                }

                // Insertar venta con su ID
                await connection.execute(
                    `INSERT INTO ventas (id, cajera_id, sucursal_id, total, estado, fecha)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        venta.id,
                        venta.cajera_id !== undefined ? venta.cajera_id : null,
                        venta.sucursal_id !== undefined ? venta.sucursal_id : null,
                        venta.total,
                        venta.estado || 'pagado',
                        venta.fecha
                    ]
                );

                // Insertar los ítems
                if (venta.items && Array.isArray(venta.items)) {
                    for (let item of venta.items) {
                        await connection.execute(
                            `INSERT INTO venta_detalle (venta_id, producto_id, cantidad, peso_kg, subtotal)
                             VALUES (?, ?, ?, ?, ?)`,
                            [
                                venta.id,
                                item.producto_id,
                                item.cantidad !== undefined ? item.cantidad : 1.0,
                                item.peso_kg !== undefined ? item.peso_kg : null,
                                item.subtotal
                            ]
                        );
                    }
                }
                insertadas++;
            } catch (err) {
                console.error(`Error al insertar venta id ${venta.id}:`, err);
                throw err; // Hacemos rollback completo si algo falla a nivel de base de datos
            }
        }

        await connection.commit();
        res.status(200).json({
            mensaje: "Sincronización completada",
            insertadas,
            duplicadas
        });
    } catch (error) {
        await connection.rollback();
        console.error("Error en sincronización:", error);
        res.status(500).json({ error: "Error al sincronizar transacciones", detalle: error.message });
    } finally {
        connection.release();
    }
});


// ============================================================================
// 1.6. ENDPOINTS CRUD BÁSICOS PARA VENTAS
// ============================================================================

// OBTENER TODAS (Con filtros y paginación)
app.get('/api/ventas', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const offset = parseInt(req.query.offset) || 0;
        const sucursal_id = req.query.sucursal_id;
        const fecha_desde = req.query.desde;
        const fecha_hasta = req.query.hasta;

        let query = 'SELECT * FROM ventas WHERE 1=1';
        const params = [];

        if (sucursal_id) {
            query += ' AND sucursal_id = ?';
            params.push(parseInt(sucursal_id));
        }
        if (fecha_desde) {
            query += ' AND fecha >= ?';
            params.push(fecha_desde);
        }
        if (fecha_hasta) {
            query += ' AND fecha <= ?';
            params.push(fecha_hasta);
        }

        query += ' ORDER BY fecha DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const [ventas] = await pool.query(query, params);
        res.json(ventas);
    } catch (error) {
        console.error("Error al consultar ventas:", error);
        res.status(500).json({ error: "Error al consultar las ventas", detalle: error.message });
    }
});

// OBTENER UNA ESPECÍFICA CON SUS ITEMS
app.get('/api/ventas/:id', async (req, res) => {
    try {
        const [venta] = await pool.query('SELECT * FROM ventas WHERE id = ?', [req.params.id]);
        if (venta.length === 0) return res.status(404).json({ error: "Venta no encontrada" });

        const [items] = await pool.query('SELECT * FROM venta_detalle WHERE venta_id = ?', [req.params.id]);

        res.json({ ...venta[0], items });
    } catch (error) {
        console.error("Error al consultar la venta por ID:", error);
        res.status(500).json({ error: "Error al consultar la venta", detalle: error.message });
    }
});

// ACTUALIZAR (Editar solo algunos campos básicos permitidos)
app.put('/api/ventas/:id', async (req, res) => {
    const { cajera_id, total, estado } = req.body;
    const saleId = req.params.id;

    const fieldsToUpdate = [];
    const params = [];

    if (cajera_id !== undefined) {
        if (cajera_id !== null && (!Number.isInteger(Number(cajera_id)) || Number(cajera_id) <= 0)) {
            return res.status(400).json({ error: "El cajera_id debe ser un entero positivo o nulo." });
        }
        fieldsToUpdate.push('cajera_id = ?');
        params.push(cajera_id);
    }

    if (total !== undefined) {
        if (!Number.isInteger(Number(total)) || Number(total) < 0) {
            return res.status(400).json({ error: "El total debe ser un número entero no negativo." });
        }
        fieldsToUpdate.push('total = ?');
        params.push(total);
    }

    if (estado !== undefined) {
        const estadosValidos = ['pagado', 'pendiente', 'anulado'];
        if (!estadosValidos.includes(estado)) {
            return res.status(400).json({ error: "El estado debe ser 'pagado', 'pendiente' o 'anulado'." });
        }
        fieldsToUpdate.push('estado = ?');
        params.push(estado);
    }

    if (fieldsToUpdate.length === 0) {
        return res.status(400).json({ error: "Debe enviar al menos un campo para actualizar (cajera_id, total, estado)." });
    }

    params.push(saleId);

    try {
        const [result] = await pool.query(
            `UPDATE ventas SET ${fieldsToUpdate.join(', ')} WHERE id = ?`,
            params
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Venta no encontrada" });

        res.json({ mensaje: "Venta actualizada correctamente" });
    } catch (error) {
        console.error("Error al actualizar venta:", error);
        res.status(500).json({ error: "Error al actualizar la venta", detalle: error.message });
    }
});

// ============================================================================
// 5. RUTAS PARA MANEJO DE 404
// ============================================================================
app.use((req, res) => {
    res.status(404).json({ error: "Ruta no encontrada" });
});



// ============================================================================
// INICIALIZACIÓN DEL SERVIDOR
// ============================================================================
// Ponemos el 4000 que casi nunca está ocupado por sistemas de desarrollo web
const PORT = 4001;
app.listen(PORT, () => {
    console.log(`Servidor backend de EcoPan corriendo en el puerto ${PORT}`);
});

module.exports = app;
