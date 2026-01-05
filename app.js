// App State
const state = {
    transactions: [],
    taxLots: {}, // Symbol -> Array of { date, quantity, price, originalDate }
    holdings: {}, // Symbol -> { quantity, costBasis, currentPrice, currentValue }
    dividends: [],
    deposits: [], // { date, amount }
    portfolioHistory: [],
    totalEquity: 0,
    totalCostBasis: 0,
    totalDividends: 0,
    sortConfig: { key: 'currentValue', direction: 'desc' },
    benchmarkData: null
};

// DOM Elements
const elements = {
    csvInput: document.getElementById('csvFileInput'),
    fileName: document.getElementById('fileNameDisplay'),
    dashboard: document.getElementById('dashboard'),
    emptyState: document.getElementById('emptyState'),
    fetchPricesBtn: document.getElementById('fetchPricesBtn'),
    // Metric displays
    totalCostBasis: document.getElementById('totalCostBasis'),
    currentValue: document.getElementById('currentValue'),
    unrealizedPl: document.getElementById('unrealizedPl'),
    totalDividends: document.getElementById('totalDividends'),
    // Charts
    compositionChart: document.getElementById('compositionChart'),
    dividendChart: document.getElementById('dividendChart'),
    vintageChart: document.getElementById('vintageChart'),
    depositsChart: document.getElementById('depositsChart'),
    holdingsTableBody: document.querySelector('#holdingsTable tbody'),
    // Benchmark
    benchmarkInput: document.getElementById('benchmarkInput'),
    runSimulationBtn: document.getElementById('runSimulationBtn'),
    benchmarkChart: document.getElementById('benchmarkChart'),
    simResults: document.getElementById('simulationResults'),
    simActualValue: document.getElementById('simActualValue'),
    simActualReturn: document.getElementById('simActualReturn'),
    simTickerLabel: document.getElementById('simTickerLabel'),
    simBenchmarkValue: document.getElementById('simBenchmarkValue'),
    simBenchmarkReturn: document.getElementById('simBenchmarkReturn'),
    simDifference: document.getElementById('simDifference')
};

// Chart Instances
let charts = {};

// Event Listeners
elements.csvInput.addEventListener('change', handleFileUpload);
elements.fetchPricesBtn.addEventListener('click', fetchWithApi);
elements.runSimulationBtn.addEventListener('click', runBenchmarkSimulation);

// Sort Listeners
document.querySelectorAll('#holdingsTable th.sortable').forEach(th => {
    th.addEventListener('click', () => {
        const key = th.dataset.key;
        if (state.sortConfig.key === key) {
            // Toggle direction
            state.sortConfig.direction = state.sortConfig.direction === 'desc' ? 'asc' : 'desc';
        } else {
            // New key, default to desc for numbers, asc for text? 
            // Let's default desc for everything except Symbol
            state.sortConfig.key = key;
            state.sortConfig.direction = key === 'symbol' ? 'asc' : 'desc';
        }
        renderHoldingsTable(elements.fetchPricesBtn.disabled === false); // Use button state to know if we have apiKey/prices
    });
});


/**
 * Handle CSV File Upload
 */
function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    elements.fileName.textContent = file.name;

    Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
            console.log("Parsed CSV:", results.data.length, "rows");
            processData(results.data);
            state.transactions = results.data;
            updateUI(false); // Update UI without live prices first
        },
        error: (err) => {
            console.error("CSV Parse Error:", err);
            alert("Error parsing CSV file.");
        }
    });
}

/**
 * Core Logic: Process Transactions (FIFO Engine)
 */
function processData(rawData) {
    resetState();

    // 1. Sort by Date (Oldest First) to ensure FIFO works
    const sortedData = rawData.sort((a, b) => {
        const dateA = new Date(a['Process Date'] || a['Activity Date']);
        const dateB = new Date(b['Process Date'] || b['Activity Date']);
        return dateA - dateB;
    });

    sortedData.forEach(row => {
        const type = row['Trans Code'];
        const symbol = row['Instrument'];
        const amountStr = row['Amount'];
        const quantityStr = row['Quantity'];
        const priceStr = row['Price'];
        const dateStr = row['Process Date'] || row['Activity Date'];

        let amount = parseMoney(amountStr);
        let quantity = parseFloat(quantityStr) || 0;
        let price = parseMoney(priceStr);
        const date = new Date(dateStr);

        // Normalize
        if (!symbol && (type === 'Buy' || type === 'Sell')) return; // Skip invalid rows

        // --- Logic Switch ---
        if (type === 'Buy') {
            handleBuy(symbol, date, quantity, price);
        } else if (type === 'Sell') {
            handleSell(symbol, date, quantity, price);
        } else if (type === 'SPL') {
            handleSplit(symbol, quantity); // Quantity in SPL is usually the ADDED shares
        } else if (type === 'CDIV' || type === 'Div') {
            handleDividend(symbol, date, amount);
        } else if (type === 'ACH' || type === 'Deposit') {
            handleDeposit(date, amount);
        } else if (row['Description'] && row['Description'].includes('Deposit')) {
            // Fallback for deposits not marked as ACH
            handleDeposit(date, amount);
        }
    });

    // Cleanup: Remove closed positions
    for (const sym in state.taxLots) {
        // Recalculate total quantity from lots to be sure
        const totalQty = state.taxLots[sym].reduce((sum, lot) => sum + lot.quantity, 0);

        if (totalQty < 0.0001) {
            delete state.taxLots[sym];
            delete state.holdings[sym];
        } else {
            // Initialize holdings summary
            state.holdings[sym] = {
                quantity: totalQty,
                costBasis: state.taxLots[sym].reduce((sum, lot) => sum + (lot.quantity * lot.price), 0),
                currentPrice: 0, // Will be filled by API
                currentValue: 0
            };
        }
    }

    calculateTotals();
    console.log("Processed State:", state);
}

function resetState() {
    state.taxLots = {};
    state.holdings = {};
    state.dividends = [];
    state.deposits = [];
    state.totalEquity = 0;
    state.totalCostBasis = 0;
    state.totalDividends = 0;
}

// --- transaction handlers ---

function handleBuy(symbol, date, quantity, price) {
    if (!state.taxLots[symbol]) state.taxLots[symbol] = [];

    // Add new Tax Lot
    state.taxLots[symbol].push({
        date: date,
        originalDate: date, // Keep track of "Vintage"
        quantity: quantity,
        price: price,
        initialCost: quantity * price
    });
}

function handleSell(symbol, date, quantity, price) {
    if (!state.taxLots[symbol]) return; // Error: Selling what we don't have

    let sharesToSell = quantity;

    // FIFO: Consume oldest lots first
    while (sharesToSell > 0.000001 && state.taxLots[symbol].length > 0) {
        let lot = state.taxLots[symbol][0]; // Oldest lot

        if (lot.quantity > sharesToSell) {
            // Partial Sell of this lot
            lot.quantity -= sharesToSell;
            sharesToSell = 0;
        } else {
            // Full Sell of this lot
            sharesToSell -= lot.quantity;
            state.taxLots[symbol].shift(); // Remove lot
        }
    }
}

function handleSplit(symbol, addedQuantity) {
    if (!state.taxLots[symbol] || state.taxLots[symbol].length === 0) return;

    // Calculate Ratio
    // We don't get the ratio directly, but we know the *added* quantity.
    // NewTotal = OldTotal + Added.
    // Ratio = NewTotal / OldTotal.

    const currentTotalShares = state.taxLots[symbol].reduce((sum, lot) => sum + lot.quantity, 0);
    if (currentTotalShares === 0) return;

    const newTotal = currentTotalShares + addedQuantity;
    const splitRatio = newTotal / currentTotalShares;

    console.log(`Split detected for ${symbol}: Ratio ~${splitRatio.toFixed(2)}`);

    // Apply to all existing lots to preserve vintage
    state.taxLots[symbol].forEach(lot => {
        lot.quantity = lot.quantity * splitRatio;
        lot.price = lot.price / splitRatio; // Cost basis per share decreases
    });
}

function handleDividend(symbol, date, amount) {
    state.dividends.push({
        date: date,
        symbol: symbol,
        amount: amount
    });
}

function handleDeposit(date, amount) {
    // Deposits are usually positive in Amount
    // If Amount is negative, it's a withdrawal
    state.deposits.push({
        date: date,
        amount: amount
    });
}

// --- Calculations & API ---

function calculateTotals() {
    state.totalCostBasis = 0;

    // Sum Cost Basis from remaining Lots
    for (const sym in state.holdings) {
        state.totalCostBasis += state.holdings[sym].costBasis;
        // Default current value to cost basis if no API
        state.holdings[sym].currentValue = state.holdings[sym].costBasis;
        state.holdings[sym].currentPrice = state.holdings[sym].costBasis / state.holdings[sym].quantity;
    }
    state.totalEquity = state.totalCostBasis; // Default until API
    state.totalDividends = state.dividends.reduce((sum, d) => sum + d.amount, 0);
}

/**
 * Fetch Live Prices (Local Python API)
 */
async function fetchWithApi() {
    // No API Key needed for local server
    elements.fetchPricesBtn.textContent = "Fetching...";
    elements.fetchPricesBtn.disabled = true;

    const symbols = Object.keys(state.holdings);

    for (const sym of symbols) {
        try {
            // Local API call
            const response = await fetch(`/api/price/${sym}`);

            if (!response.ok) throw new Error("Server Error");

            const data = await response.json();

            if (data.c) { // 'c' is current price
                state.holdings[sym].currentPrice = data.c;
                state.holdings[sym].currentValue = data.c * state.holdings[sym].quantity;
                console.log(`Fetched ${sym}: $${data.c}`);
            }
        } catch (e) {
            console.error(`Failed to fetch ${sym}`, e);
        }
    }

    // Recalculate Equity
    state.totalEquity = 0;
    for (const sym in state.holdings) {
        state.totalEquity += state.holdings[sym].currentValue;
    }

    elements.fetchPricesBtn.textContent = "Prices Updated";
    setTimeout(() => {
        elements.fetchPricesBtn.textContent = "Fetch Live Prices";
        elements.fetchPricesBtn.disabled = false;
    }, 3000);

    updateUI(true);
}

// --- Rendering ---

function updateUI(hasLivePrices) {
    // Reveal Dashboard
    elements.emptyState.classList.add('hidden');
    elements.dashboard.classList.remove('hidden');

    // 1. Metrics
    elements.totalCostBasis.textContent = formatMoney(state.totalCostBasis);
    elements.totalDividends.textContent = formatMoney(state.totalDividends);

    if (hasLivePrices) {
        elements.currentValue.textContent = formatMoney(state.totalEquity);
        const diff = state.totalEquity - state.totalCostBasis;
        const pct = (diff / state.totalCostBasis) * 100;
        const sign = diff >= 0 ? '+' : '';
        elements.unrealizedPl.innerHTML = `<span class="${diff >= 0 ? 'positive' : 'negative'}">${sign}${formatMoney(diff)} (${sign}${pct.toFixed(2)}%)</span>`;
    } else {
        elements.currentValue.textContent = "---";
        elements.unrealizedPl.textContent = "(Fetch Prices to See Value)";
        // Use cost basis for charts if no live price, but label it clearly?
        // Actually, we default currentValue = costBasis in calculateTotals, so charts sort of work but look flat.
    }

    renderCompositionChart();
    renderDividendChart();
    renderVintageChart();
    renderDepositsChart();
    renderHoldingsTable(hasLivePrices);
}

function renderCompositionChart() {
    const ctx = elements.compositionChart.getContext('2d');

    // Sort by Value descent
    const sortedHoldings = Object.entries(state.holdings)
        .sort(([, a], [, b]) => b.currentValue - a.currentValue);

    const labels = sortedHoldings.map(([sym]) => sym);
    const data = sortedHoldings.map(([, h]) => h.currentValue);

    if (charts.composition) charts.composition.destroy();

    charts.composition = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: generateColors(labels.length),
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { position: 'right', labels: { color: '#fff' } }
            }
        }
    });
}

function renderDividendChart() {
    const ctx = elements.dividendChart.getContext('2d');

    // Group by Quarter
    const quarterly = {};
    state.dividends.forEach(d => {
        const y = d.date.getFullYear();
        const q = Math.floor(d.date.getMonth() / 3) + 1;
        const key = `${y} Q${q}`;
        quarterly[key] = (quarterly[key] || 0) + d.amount;
    });

    const labels = Object.keys(quarterly).sort(); // simple string sort works for YYYY QX
    const data = labels.map(k => quarterly[k]);

    if (charts.dividends) charts.dividends.destroy();

    charts.dividends = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Dividends Received',
                data: data,
                backgroundColor: '#00c805'
            }]
        },
        options: {
            plugins: { legend: { display: false } },
            scales: {
                y: { grid: { color: '#333' }, ticks: { color: '#888' } },
                x: { grid: { display: false }, ticks: { color: '#888' } }
            }
        }
    });
}

function renderVintageChart() {
    const ctx = elements.vintageChart.getContext('2d');

    // Aggregate by Year
    const vintages = {};
    for (const [sym, lots] of Object.entries(state.taxLots)) {
        const currentPrice = state.holdings[sym].currentPrice;
        lots.forEach(lot => {
            const y = lot.originalDate.getFullYear();
            if (!vintages[y]) vintages[y] = { cost: 0, value: 0 };

            vintages[y].cost += (lot.quantity * lot.price);
            vintages[y].value += (lot.quantity * currentPrice);
        });
    }

    const years = Object.keys(vintages).sort();
    const costs = years.map(y => vintages[y].cost);
    const values = years.map(y => vintages[y].value);
    const returns = years.map(y => {
        const c = vintages[y].cost;
        const v = vintages[y].value;
        return c > 0 ? ((v - c) / c) * 100 : 0;
    });

    if (charts.vintage) charts.vintage.destroy();

    charts.vintage = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: years,
            datasets: [
                {
                    label: 'Invested Capital',
                    data: costs,
                    backgroundColor: '#555',
                    order: 2
                },
                {
                    label: 'Current Value',
                    data: values,
                    backgroundColor: '#0082ff',
                    order: 3
                },
                {
                    label: 'Return %',
                    data: returns,
                    type: 'line',
                    borderColor: '#00c805',
                    backgroundColor: 'rgba(0, 200, 5, 0.1)',
                    borderWidth: 2,
                    yAxisID: 'y1',
                    order: 1,
                    pointStyle: 'circle',
                    pointRadius: 4,
                    pointHoverRadius: 6
                }
            ]
        },
        options: {
            responsive: true,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            scales: {
                y: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    grid: { color: '#333' },
                    ticks: { color: '#888', callback: (val) => '$' + val }
                },
                y1: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    grid: { drawOnChartArea: false }, // only want the grid lines for one axis to show up
                    ticks: { color: '#00c805', callback: (val) => val + '%' }
                },
                x: { ticks: { color: '#888' } }
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            let label = context.dataset.label || '';
                            if (label) {
                                label += ': ';
                            }
                            if (context.parsed.y !== null) {
                                if (context.dataset.yAxisID === 'y1') {
                                    label += context.parsed.y.toFixed(2) + '%';
                                } else {
                                    label += new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(context.parsed.y);
                                }
                            }
                            return label;
                        }
                    }
                }
            }
        }
    });
}

function renderDepositsChart() {
    const ctx = elements.depositsChart.getContext('2d');

    // 1. Aggregate both Deposits and Dividends by Month
    const byMonth = {};

    // Process Deposits
    state.deposits.forEach(d => {
        const key = `${d.date.getFullYear()}-${String(d.date.getMonth() + 1).padStart(2, '0')}`;
        if (!byMonth[key]) byMonth[key] = { dep: 0, div: 0 };
        byMonth[key].dep += d.amount;
    });

    // Process Dividends
    state.dividends.forEach(d => {
        const key = `${d.date.getFullYear()}-${String(d.date.getMonth() + 1).padStart(2, '0')}`;
        if (!byMonth[key]) byMonth[key] = { dep: 0, div: 0 };
        byMonth[key].div += d.amount;
    });

    // 2. Sort Months & Calculate Running Totals
    const months = Object.keys(byMonth).sort();

    let runningDep = 0;
    let runningDiv = 0;

    const depData = [];
    const divData = [];

    months.forEach(m => {
        runningDep += byMonth[m].dep;
        runningDiv += byMonth[m].div;

        depData.push(runningDep);
        divData.push(runningDiv);
    });

    if (charts.deposits) charts.deposits.destroy();

    charts.deposits = new Chart(ctx, {
        type: 'line',
        data: {
            labels: months,
            datasets: [
                {
                    label: 'Cumulative Dividends (Reinvested)',
                    data: divData,
                    borderColor: '#ffc107', // Amber
                    backgroundColor: 'rgba(255, 193, 7, 0.5)',
                    fill: '-1', // Fill to dataset below (stacking visual)
                    tension: 0.4,
                    pointRadius: 0
                },
                {
                    label: 'Net Capital Deposited',
                    data: depData,
                    borderColor: '#00c805', // Green
                    backgroundColor: 'rgba(0, 200, 5, 0.2)',
                    fill: 'origin', // Fill to bottom
                    tension: 0.4,
                    pointRadius: 0
                }
            ]
        },
        options: {
            plugins: {
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        label: function (context) {
                            return context.dataset.label + ': ' + formatMoney(context.parsed.y);
                        }
                    }
                },
                title: {
                    display: true,
                    text: 'Capital Sources: Deposits + Dividends',
                    color: '#aaa'
                }
            },
            interaction: {
                mode: 'nearest',
                axis: 'x',
                intersect: false
            },
            scales: {
                y: {
                    stacked: true, // Enable stacking
                    grid: { color: '#333' },
                    ticks: { color: '#888', callback: (val) => '$' + val } // Show $
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#888', maxTicksLimit: 12 }
                }
            }
        }
    });
}

function renderHoldingsTable(hasLivePrices) {
    const tbody = elements.holdingsTableBody;
    tbody.innerHTML = '';

    // Sort Data
    const entries = Object.entries(state.holdings);

    entries.sort((a, b) => {
        const [symA, dataA] = a;
        const [symB, dataB] = b;

        let valA, valB;

        // Extract values
        switch (state.sortConfig.key) {
            case 'symbol': valA = symA; valB = symB; break;
            case 'quantity': valA = dataA.quantity; valB = dataB.quantity; break;
            case 'avgPrice': valA = dataA.costBasis / dataA.quantity; valB = dataB.costBasis / dataB.quantity; break;
            case 'costBasis': valA = dataA.costBasis; valB = dataB.costBasis; break;
            case 'currentPrice': valA = dataA.currentPrice; valB = dataB.currentPrice; break;
            case 'currentValue': valA = dataA.currentValue; valB = dataB.currentValue; break;
            case 'return':
                const gainA = dataA.currentValue - dataA.costBasis;
                valA = (dataA.costBasis > 0) ? (gainA / dataA.costBasis) : -9999;
                const gainB = dataB.currentValue - dataB.costBasis;
                valB = (dataB.costBasis > 0) ? (gainB / dataB.costBasis) : -9999;
                break;
            default: valA = 0; valB = 0;
        }

        if (valA < valB) return state.sortConfig.direction === 'asc' ? -1 : 1;
        if (valA > valB) return state.sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
    });

    entries.forEach(([symbol, h]) => {
        const row = document.createElement('tr');

        // Calcs
        const avgPrice = h.costBasis / h.quantity;
        const gain = h.currentValue - h.costBasis; // If no live price, this is 0
        const gainPct = (h.costBasis > 0) ? (gain / h.costBasis) * 100 : 0;
        const isPos = gain >= 0;

        let returnHtml = '<span class="text-secondary">--</span>';
        let currentPriceHtml = '<span class="text-secondary">--</span>';
        let currentValueHtml = `<span class="text-secondary">${formatMoney(h.costBasis)}</span>`;

        if (hasLivePrices) {
            currentPriceHtml = formatMoney(h.currentPrice);
            currentValueHtml = `<strong>${formatMoney(h.currentValue)}</strong>`;

            returnHtml = `<span class="${isPos ? 'positive' : 'negative'}">
                ${isPos ? '+' : ''}${gainPct.toFixed(2)}%
                <br>
                <small>${isPos ? '+' : ''}${formatMoney(gain)}</small>
            </span>`;
        } else {
            // Even without live prices, show cost basis as current value (fallback)
        }

        row.innerHTML = `
            <td><strong>${symbol}</strong></td>
            <td class="text-right mono-font">${h.quantity.toFixed(4)}</td>
            <td class="text-right mono-font">${formatMoney(avgPrice)}</td>
            <td class="text-right mono-font">${formatMoney(h.costBasis)}</td>
            <td class="text-right mono-font">${currentPriceHtml}</td>
            <td class="text-right mono-font">${currentValueHtml}</td>
            <td class="text-right mono-font">${returnHtml}</td>
        `;
        tbody.appendChild(row);
    });

    updateSortIcons();
}

function updateSortIcons() {
    document.querySelectorAll('#holdingsTable th.sortable').forEach(th => {
        th.classList.remove('asc', 'desc');
        if (th.dataset.key === state.sortConfig.key) {
            th.classList.add(state.sortConfig.direction);
        }
    });
}

// --- Helpers ---

function parseMoney(str) {
    if (!str) return 0;
    // Remove '$', '(', ')' and handle negative accounting format ($500)
    let clean = str.replace(/[$,]/g, '');
    let isNegative = false;
    if (clean.includes('(')) {
        isNegative = true;
        clean = clean.replace(/[()]/g, '');
    }
    let val = parseFloat(clean);
    return isNegative ? -val : val;
}

function formatMoney(num) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
}

function generateColors(count) {
    // Generate nice palette
    const baseColors = [
        '#00c805', '#0082ff', '#ff3b30', '#ffc107', '#9c27b0', '#00bcd4',
        '#ff9800', '#795548', '#607d8b', '#E91E63'
    ];

    let colors = [];
    while (colors.length < count) {
        colors = colors.concat(baseColors);
    }
    return colors.slice(0, count);
}

/**
 * BENCHMARK SIMULATION (Using Local API)
 */

async function runBenchmarkSimulation() {
    const ticker = elements.benchmarkInput.value.trim().toUpperCase();
    if (!ticker) return;

    elements.runSimulationBtn.textContent = "Simulating...";
    elements.runSimulationBtn.disabled = true;

    try {
        // 1. Fetch History from Local API
        // No caching needed directly here as server handles it or is fast enough, 
        // but we can keep caching if we want.
        const candleData = await fetchBenchmarkHistory(ticker);
        if (!candleData || !candleData.c) {
            throw new Error("No data found for symbol");
        }

        // 2. Map Candle Data [Timestamp -> Close Price]
        // Finnhub returns { t: [], c: [] }
        const priceMap = {};
        candleData.t.forEach((timestamp, i) => {
            // Normalize to YYYY-MM-DD
            const date = new Date(timestamp * 1000);
            const key = date.toISOString().split('T')[0];
            priceMap[key] = candleData.c[i];
        });

        // 3. Simulate "Buying" on every Deposit Date
        let simShares = 0;
        let simInvested = 0; // Cumulative deposits used

        // We need deposits sorted by date
        const sortedDeposits = [...state.deposits].sort((a, b) => a.date - b.date);

        // Find earliest deposit to filter noise
        if (sortedDeposits.length === 0) {
            throw new Error("No deposits found to simulate");
        }

        // We'll build a daily timeline from First Deposit -> Today
        const start = sortedDeposits[0].date;
        const end = new Date();

        const chartLabels = [];
        const chartSimValue = [];
        const chartActualInvested = [];

        let currentDepIndex = 0;
        let cumulativeDeposits = 0;

        // Iterate strictly through the available candle data timeline to mimic reality
        // Or iterate by Day and lookup price

        // Let's iterate the Candle Data itself, as that is the "Time" axis we have prices for
        // We filter for dates >= start date

        for (let i = 0; i < candleData.t.length; i++) {
            const ts = candleData.t[i];
            const price = candleData.c[i];
            const date = new Date(ts * 1000);

            if (date < start) continue;

            const dateKey = date.toISOString().split('T')[0];

            // Check for deposits on or before this day that haven't been processed
            // (Simplification: Process all deposits up to this day)
            while (currentDepIndex < sortedDeposits.length && sortedDeposits[currentDepIndex].date <= date) {
                const dep = sortedDeposits[currentDepIndex];
                if (dep.amount > 0) { // Only buy with inflows
                    simInvested += dep.amount;
                    cumulativeDeposits += dep.amount;
                    simShares += (dep.amount / price);
                } else {
                    // Withdrawal? Sell sim shares?
                    // Logic: withdrawal amount / price = shares sold
                    const sharesToSell = Math.abs(dep.amount) / price;
                    simShares -= sharesToSell;
                    cumulativeDeposits += dep.amount; // decreases total invested
                }
                currentDepIndex++;
            }

            // Daily Snapshots
            if (date.getDate() % 5 === 0) { // Downsample: every 5th day
                chartLabels.push(dateKey);
                chartSimValue.push(simShares * price);
                chartActualInvested.push(cumulativeDeposits);
            }
        }

        // 4. Update UI
        updateBenchmarkUI(ticker, simShares, simInvested, priceMap);
        renderBenchmarkChart(chartLabels, chartActualInvested, chartSimValue, ticker);

    } catch (err) {
        console.error(err);
        alert("Simulation failed: " + err.message);
    } finally {
        elements.runSimulationBtn.textContent = "Simulate";
        elements.runSimulationBtn.disabled = false;
    }
}

async function fetchBenchmarkHistory(ticker) {
    // Call Local API
    console.log("Fetching API:", ticker);
    const res = await fetch(`/api/history/${ticker}`);
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`API Error ${res.status}: ${txt}`);
    }
    return await res.json();
}

// --- Caching Helpers ---
function loadFromCache(key) {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : null;
}

function saveToCache(key, data) {
    localStorage.setItem(key, JSON.stringify({
        timestamp: Date.now(),
        data: data
    }));
}

function updateBenchmarkUI(ticker, finalShares, finalInvested, priceMap) {
    elements.simResults.classList.remove('hidden');
    elements.simTickerLabel.textContent = ticker;

    // Get Current Price of Benchmark (last available in map)
    const prices = Object.values(priceMap);
    const lastPrice = prices[prices.length - 1];

    const simValue = finalShares * lastPrice;
    const simGain = simValue - finalInvested;
    const simRet = (simGain / finalInvested) * 100;

    // Actual Portfolio
    const actualValue = state.totalEquity;
    // We compare against the "Benchmark Invested" (which is essentially Net Deposits adjusted)
    // Technically actualInvested == Total Cost Basis (roughly) or Net Deposits. 
    // Let's use Net Deposits sum for apple-to-apple input comparison?
    // Actually state.totalCostBasis is the remaining input.
    // Let's use `state.totalEquity` vs `simValue`.

    // Diff
    const diff = actualValue - simValue;

    elements.simActualValue.textContent = formatMoney(actualValue);
    elements.simActualReturn.textContent = "Current Portfolio";

    elements.simBenchmarkValue.textContent = formatMoney(simValue);
    elements.simBenchmarkReturn.innerHTML = `<span class="${simGain >= 0 ? 'positive' : 'negative'}">${simGain >= 0 ? '+' : ''}${simRet.toFixed(2)}%</span>`;

    elements.simDifference.innerHTML = `<span class="${diff >= 0 ? 'positive' : 'negative'}">${diff >= 0 ? '+' : ''}${formatMoney(diff)}</span>`;
}

function renderBenchmarkChart(labels, investedData, simData, ticker) {
    const ctx = elements.benchmarkChart.getContext('2d');

    if (charts.benchmark) charts.benchmark.destroy();

    charts.benchmark = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Net Deposits (Input)',
                    data: investedData,
                    borderColor: '#9ea5b1',
                    borderDash: [5, 5],
                    borderWidth: 1,
                    pointRadius: 0
                },
                {
                    label: `Scenario: 100% ${ticker}`,
                    data: simData,
                    borderColor: '#0082ff',
                    backgroundColor: 'rgba(0, 130, 255, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            plugins: {
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        label: (c) => c.dataset.label + ': ' + formatMoney(c.parsed.y)
                    }
                }
            },
            interaction: {
                mode: 'nearest',
                axis: 'x',
                intersect: false
            },
            scales: {
                y: {
                    grid: { color: '#333' },
                    ticks: { color: '#888', callback: (val) => '$' + val }
                },
                x: { display: false }
            }
        }
    });
}

// --- Helpers ---
