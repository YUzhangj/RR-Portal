FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py matcher_unified.py build_db.py process_schedule.py ./
COPY templates ./templates
RUN mkdir -p data uploads output

EXPOSE 5010
ENV PORT=5010
CMD ["python", "app.py", "--host", "0.0.0.0", "--port", "5010"]
