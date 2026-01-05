# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "flask",
#     "yfinance",
# ]
# ///

from flask import Flask, jsonify, request, send_from_directory
import yfinance as yf
import os

app = Flask(__name__, static_folder='.')

# Serve index.html at root
@app.route('/')
def home():
    return send_from_directory('.', 'index.html')

# Serve static files (js, css, csv)
@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('.', path)

# API: Get Current Price
@app.route('/api/price/<ticker>')
def get_price(ticker):
    try:
        ticker = ticker.upper()
        stock = yf.Ticker(ticker)
        # fast_info is often faster/more reliable for current price than .info
        price = stock.fast_info.last_price
        
        if price is None:
             # Fallback to history (1d) to get latest close
             hist = stock.history(period="1d")
             if not hist.empty:
                 price = hist['Close'].iloc[-1]
        
        if price:
            return jsonify({'symbol': ticker, 'c': price}) # Match Finnhub 'c' format for easy frontend compat
        else:
            return jsonify({'error': 'Price not found'}), 404
            
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# API: Get Historical Data (Benchmark)
@app.route('/api/history/<ticker>')
def get_history(ticker):
    try:
        ticker = ticker.upper()
        # Fetch max history to ensure we cover the portfolio lifetime
        # Auto-adjust interval based on range if needed, but '1d' is standard.
        stock = yf.Ticker(ticker)
        hist = stock.history(period="max", interval="1d")
        
        if hist.empty:
            return jsonify({'s': 'no_data'}), 404

        # Transform to Finnhub-like format {t: [], c: []} to minimize frontend changes
        # Timestamps in seconds
        timestamps = (hist.index.astype(int) // 10**9).tolist()
        closes = hist['Close'].tolist()
        
        return jsonify({
            's': 'ok',
            't': timestamps,
            'c': closes
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    print("Starting Robinhood Analyzer Server...")
    print("Run with: uv run server.py")
    print("Open http://localhost:5000 in your browser")
    app.run(debug=True, port=5000)
