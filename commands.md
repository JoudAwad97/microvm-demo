# Export variables

export TOKEN=<TOKEN_VALUE>
export ENDPOINT=<ENDPOINT_VALUE>

# read state

curl -s "https://$ENDPOINT/state" -H "X-aws-proxy-auth: $TOKEN" | jq .

# run steps

curl -s -X POST "https://$ENDPOINT/exec" -H "X-aws-proxy-auth: $TOKEN" -H 'content-type: application/json' -d '{"op":"add","value":5}'  | jq .
curl -s -X POST "https://$ENDPOINT/exec" -H "X-aws-proxy-auth: $TOKEN" -H 'content-type: application/json' -d '{"op":"mul","value":3}' | jq .
