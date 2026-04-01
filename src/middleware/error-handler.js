export function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: "Route not found"
  });
}

export function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;

  res.status(statusCode).json({
    success: false,
    error: err.message || "Internal server error",
    details: err.details || null
  });
}
