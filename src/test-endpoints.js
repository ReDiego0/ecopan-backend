const axios = require('axios');

const BASE_URL = 'http://localhost:4001/api';

async function runTests() {
    console.log("=== INICIANDO PRUEBAS DE ENDPOINTS DE VENTAS ===");

    // Para limpiar posibles residuos de pruebas anteriores en la DB (si las hubiera)
    // Usaremos IDs de prueba altos para evitar colisiones: 99991, 99992
    const testIds = [99991, 99992];

    try {
        // PRUEBA 1: Listar ventas (GET /api/ventas)
        console.log("\n[Prueba 1] Consultar ventas...");
        const resList = await axios.get(`${BASE_URL}/ventas?limit=5`);
        console.log(`✅ Conexión establecida. Ventas obtenidas: ${resList.data.length}`);

        // PRUEBA 2: Crear venta individual válida (POST /api/ventas)
        console.log("\n[Prueba 2] Crear venta individual válida...");
        const ventaIndividual = {
            sucursal_id: 1,
            cajera_id: 1,
            total: 2400,
            estado: 'pendiente',
            fecha: new Date().toISOString().slice(0, 19).replace('T', ' '),
            items: [
                { producto_id: 1, cantidad: 1.0, peso_kg: 0.8, subtotal: 2400 }
            ]
        };
        const resCreate = await axios.post(`${BASE_URL}/ventas`, ventaIndividual);
        console.log("✅ Venta individual creada exitosamente. Venta ID:", resCreate.data.venta_id);
        const createdIndividualId = resCreate.data.venta_id;

        // PRUEBA 3: Sincronización POS (POST /api/ventas/sync)
        console.log("\n[Prueba 3] Sincronizar transacciones nuevas desde el POS...");
        const ventasSync = [
            {
                id: testIds[0],
                sucursal_id: 1,
                cajera_id: 1,
                total: 4800,
                estado: 'pagado',
                fecha: '2026-05-23 15:30:00',
                items: [
                    { producto_id: 1, cantidad: 2.0, peso_kg: 1.6, subtotal: 4800 }
                ]
            },
            {
                id: testIds[1],
                sucursal_id: 1,
                cajera_id: 2,
                total: 2600,
                estado: 'pagado',
                fecha: '2026-05-23 15:31:00',
                items: [
                    { producto_id: 2, cantidad: 1.0, peso_kg: 0.6, subtotal: 2600 }
                ]
            }
        ];

        const resSync = await axios.post(`${BASE_URL}/ventas/sync`, { ventas: ventasSync });
        console.log("Response Sync:", resSync.data);
        if (resSync.data.insertadas === 2 && resSync.data.duplicadas === 0) {
            console.log("✅ Sincronización de transacciones exitosa.");
        } else {
            console.error("❌ Falló la sincronización esperada.");
        }

        // PRUEBA 4: Evitar duplicados (POST /api/ventas/sync)
        console.log("\n[Prueba 4] Enviar de nuevo las mismas transacciones para verificar duplicados...");
        const resSyncDup = await axios.post(`${BASE_URL}/ventas/sync`, { ventas: ventasSync });
        console.log("Response Sync Duplicados:", resSyncDup.data);
        if (resSyncDup.data.insertadas === 0 && resSyncDup.data.duplicadas === 2) {
            console.log("✅ Control de duplicados funcionando correctamente.");
        } else {
            console.error("❌ Falló el control de duplicados.");
        }

        // PRUEBA 5: Seguridad y Validación (POST /api/ventas/sync con datos incorrectos / SQL Injection)
        console.log("\n[Prueba 5] Seguridad: Enviar datos con SQL Injection e inputs inválidos...");
        const ventasSospechosas = [
            {
                id: 99993,
                sucursal_id: "1; DROP TABLE ventas;", // Intento de SQL injection en entero
                total: -100, // Total inválido
                estado: 'pagado',
                fecha: 'fecha-invalida',
                items: []
            }
        ];
        try {
            await axios.post(`${BASE_URL}/ventas/sync`, { ventas: ventasSospechosas });
            console.error("❌ Error: Se permitió el ingreso de datos inválidos/inyección.");
        } catch (err) {
            if (err.response && err.response.status === 400) {
                console.log("✅ Seguridad confirmada: La petición fue rechazada correctamente con código 400.");
                console.log("Detalle del rechazo:", err.response.data);
            } else {
                console.error("❌ Se obtuvo un código de respuesta inesperado:", err.response ? err.response.status : err.message);
            }
        }

        // PRUEBA 6: Obtener venta por ID con detalles (GET /api/ventas/:id)
        console.log(`\n[Prueba 6] Obtener la venta sincronizada ID ${testIds[0]} con sus detalles...`);
        const resGetOne = await axios.get(`${BASE_URL}/ventas/${testIds[0]}`);
        console.log("Venta obtenida:", resGetOne.data);
        if (resGetOne.data && resGetOne.data.items && resGetOne.data.items.length > 0) {
            console.log("✅ Consulta de detalles de venta exitosa.");
        } else {
            console.error("❌ Falló la obtención de detalles de venta.");
        }

        // PRUEBA 7: Editar estado de venta (PUT /api/ventas/:id)
        console.log(`\n[Prueba 7] Actualizar el estado de la venta ID ${testIds[0]} a 'anulado'...`);
        const resPut = await axios.put(`${BASE_URL}/ventas/${testIds[0]}`, { estado: 'anulado' });
        console.log("Response PUT:", resPut.data);

        // Validar el cambio en la base de datos
        const resGetOneUpdated = await axios.get(`${BASE_URL}/ventas/${testIds[0]}`);
        if (resGetOneUpdated.data.estado === 'anulado') {
            console.log("✅ Actualización de estado (Cancelación lógica) exitosa.");
        } else {
            console.error("❌ Falló la actualización de estado.");
        }

        // PRUEBA 8: Verificar inexistencia de eliminación física (DELETE /api/ventas/:id)
        console.log(`\n[Prueba 8] Intentar eliminación física de la venta ID ${testIds[0]}...`);
        try {
            await axios.delete(`${BASE_URL}/ventas/${testIds[0]}`);
            console.error("❌ Error: Se permitió la eliminación física mediante DELETE.");
        } catch (err) {
            if (err.response && err.response.status === 404) {
                console.log("✅ Seguridad confirmada: El endpoint DELETE no existe (retornó 404).");
            } else {
                console.error("❌ Respuesta inesperada al intentar DELETE:", err.response ? err.response.status : err.message);
            }
        }

        // Limpieza final de la base de datos de los registros de prueba altos
        console.log("\n[Limpieza] Eliminando registros de prueba altos de la BD directamente...");
        const pool = require('./src/config/db');
        // Eliminar detalles de los IDs altos de prueba
        await pool.query('DELETE FROM venta_detalle WHERE venta_id IN (?, ?)', testIds);
        await pool.query('DELETE FROM venta_detalle WHERE venta_id = ?', [createdIndividualId]);
        // Eliminar ventas de prueba
        await pool.query('DELETE FROM ventas WHERE id IN (?, ?)', testIds);
        await pool.query('DELETE FROM ventas WHERE id = ?', [createdIndividualId]);
        await pool.end();
        console.log("✅ Limpieza completada.");
        console.log("\n=== ¡TODAS LAS PRUEBAS COMPLETADAS EXITOSAMENTE! ===");

    } catch (error) {
        console.error("❌ Ocurrió un error inesperado durante las pruebas:", error.message);
        if (error.response) {
            console.error("Datos del error de respuesta:", error.response.data);
        }
        process.exit(1);
    }
}

runTests();
