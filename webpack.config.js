const path = require('path');
const webpack = require('webpack');

module.exports = {
  entry: './src/lambda.ts',
  target: 'node',
  mode: 'production',
  resolve: {
    extensions: ['.ts', '.js'],
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'main.js',
    libraryTarget: 'commonjs2',
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  plugins: [
    new webpack.IgnorePlugin({ resourceRegExp: /^aws-sdk$/ }),
    // ✅ suppress dynamic require warnings from NestJS internals
    new webpack.ContextReplacementPlugin(
      /(.+)?@nestjs(\/|\\)core(.+)?/,
      path.resolve(__dirname, 'src'),
      {}
    ),
    new webpack.ContextReplacementPlugin(
      /(.+)?express(\/|\\)(.+)?/,
      path.resolve(__dirname, 'src'),
      {}
    ),
  ],
  optimization: {
    minimize: false,
  },
  stats: {
    errorDetails: true,
  },
};
