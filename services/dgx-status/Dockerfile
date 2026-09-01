FROM python:3.12-slim-bookworm

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8330

COPY server.py ./server.py

EXPOSE 8330
CMD ["python3", "/app/server.py"]
